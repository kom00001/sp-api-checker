export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const reportId = url.searchParams.get('id');
    if (!reportId) return json({ error: 'id parameter required' }, 400);

    const token = await getAccessToken(env);
    const base = 'https://sellingpartnerapi-fe.amazon.com/reports/2021-06-30';
    const h = { headers: { 'x-amz-access-token': token } };

    // レポート状態確認
    const statusRes = await fetch(`${base}/reports/${reportId}`, h);
    if (!statusRes.ok) {
      const errText = await statusRes.text();
      return json({ status: 'FAILED', error: `Status check ${statusRes.status}: ${errText.substring(0, 200)}` }, 500);
    }
    const statusData = await statusRes.json();
    const processingStatus = statusData.processingStatus;

    if (processingStatus === 'IN_QUEUE' || processingStatus === 'IN_PROGRESS') {
      return json({ status: 'IN_PROGRESS', processingStatus });
    }
    if (processingStatus === 'CANCELLED' || processingStatus === 'FATAL') {
      return json({ status: 'FAILED', processingStatus, error: 'Report generation failed' });
    }
    if (processingStatus !== 'DONE') {
      return json({ status: 'UNKNOWN', processingStatus });
    }

    const documentId = statusData.reportDocumentId;
    if (!documentId) return json({ status: 'FAILED', error: 'reportDocumentId missing' }, 500);

    // ドキュメント取得
    const docRes = await fetch(`${base}/documents/${documentId}`, h);
    if (!docRes.ok) {
      const errText = await docRes.text();
      return json({ status: 'FAILED', error: `Document fetch ${docRes.status}: ${errText.substring(0, 200)}` }, 500);
    }
    const docData = await docRes.json();

    // レポートダウンロード
    const reportRes = await fetch(docData.url);
    if (!reportRes.ok) {
      return json({ status: 'FAILED', error: `Download failed: ${reportRes.status}` }, 500);
    }

    let reportBuffer;
    if (docData.compressionAlgorithm === 'GZIP') {
      const stream = reportRes.body.pipeThrough(new DecompressionStream('gzip'));
      reportBuffer = await new Response(stream).arrayBuffer();
    } else {
      reportBuffer = await reportRes.arrayBuffer();
    }

    const reportText = new TextDecoder('utf-8').decode(reportBuffer);
    const { skus, debug } = parseReport(reportText);

    // KV保存（既存のキー名 sku_list を維持）
    const payload = {
      updated: new Date().toISOString(),
      count: skus.length,
      summary: summarize(skus),
      skus,
    };
    const payloadStr = JSON.stringify(payload);
    const payloadSize = new TextEncoder().encode(payloadStr).length;

    let kvSaveStatus = 'success';
    let kvSaveError = null;
    try {
      await env.SKU_CACHE.put('sku_list', payloadStr, {
        expirationTtl: 60 * 60 * 24 * 7,
      });
    } catch (e) {
      kvSaveStatus = 'failed';
      kvSaveError = e.message;
    }

    return json({
      status: 'DONE',
      count: skus.length,
      summary: payload.summary,
      debug: {
        payloadSizeBytes: payloadSize,
        kvSaveStatus,
        kvSaveError,
        kvBinding: env.SKU_CACHE ? 'bound' : 'NOT BOUND',
        parseDebug: debug,
      },
    });
  } catch (e) {
    return json({ status: 'FAILED', error: e.message, stack: e.stack }, 500);
  }
}

// 値正規化: BOM除去、前後空白除去、ダブルクォート除去
const clean = (v) => (v ?? '').replace(/^\uFEFF/, '').trim().replace(/^"+|"+$/g, '').trim();

function parseReport(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { skus: [], debug: { totalRows: 0, skipped: {}, headers: [], idx: {} } };

  // ヘッダー正規化（BOM・引用符除去）
  const headers = lines[0].split('\t').map(clean);

  // ヘッダー検索（完全一致、複数名対応）
  const find = (...names) => {
    for (const n of names) {
      const i = headers.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };

  const idx = {
    sku: find('出品者SKU', 'seller-sku'),
    asin: find('商品ID', 'asin1', 'product-id'),  // 完全一致で「商品IDタイプ」を誤検出しない
    name: find('商品名', 'item-name'),
    price: find('価格', 'price'),
    quantity: find('数量', 'quantity'),
    stockQty: find('在庫数', 'afn-fulfillable-quantity'),
    channel: find('フルフィルメント・チャンネル', 'fulfillment-channel'),
    status: find('ステータス', 'status'),
  };

  const skipped = { notActive: 0, noSku: 0, noAsin: 0 };
  const skus = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t').map(clean);
    if (cols.length < 5) continue;

    const status = idx.status >= 0 ? cols[idx.status] : 'Active';
    if (status !== 'Active') {
      skipped.notActive++;
      continue;
    }

    const sku = idx.sku >= 0 ? cols[idx.sku] : '';
    if (!sku) {
      skipped.noSku++;
      continue;
    }

    const asin = idx.asin >= 0 ? cols[idx.asin] : '';
    if (!asin) {
      skipped.noAsin++;
      continue;
    }

    const channelRaw = idx.channel >= 0 ? cols[idx.channel] : '';
    const channel = channelRaw.startsWith('AMAZON') ? 'FBA' : 'FBM';

    const qtyStr = (idx.quantity >= 0 ? cols[idx.quantity] : '') ||
                   (idx.stockQty >= 0 ? cols[idx.stockQty] : '');
    const quantity = parseInt(qtyStr || '0', 10) || 0;

    const priceStr = idx.price >= 0 ? cols[idx.price] : '0';
    const price = parseFloat(priceStr || '0') || 0;

    skus.push({
      sku,
      asin,
      name: (idx.name >= 0 ? cols[idx.name] : '').substring(0, 80),
      price,
      quantity,
      channel,
    });
  }

  return {
    skus,
    debug: {
      totalRows: lines.length - 1,
      skipped,
      headers,
      idx,
    },
  };
}

function summarize(skus) {
  const fba = skus.filter((s) => s.channel === 'FBA').length;
  const fbm = skus.filter((s) => s.channel === 'FBM').length;
  return { total: skus.length, fba, fbm };
}

async function getAccessToken(env) {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: env.SP_REFRESH_TOKEN,
      client_id: env.SP_LWA_APP_ID,
      client_secret: env.SP_LWA_CLIENT_SECRET,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('認証失敗');
  return data.access_token;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
