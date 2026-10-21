// File: functions/api/report-check.js
export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const reportId = url.searchParams.get('id');
    if (!reportId) return json({ error: 'id parameter required' }, 400);

    const token = await getAccessToken(env);
    const base = 'https://sellingpartnerapi-fe.amazon.com/reports/2021-06-30';
    const h = { headers: { 'x-amz-access-token': token } };

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

    const docRes = await fetch(`${base}/documents/${documentId}`, h);
    if (!docRes.ok) {
      const errText = await docRes.text();
      return json({ status: 'FAILED', error: `Document fetch ${docRes.status}: ${errText.substring(0, 200)}` }, 500);
    }
    const docData = await docRes.json();

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

const clean = (v) => (v ?? '').replace(/^\uFEFF/, '').trim().replace(/^"+|"+$/g, '').trim();

function parseReport(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { skus: [], debug: { totalRows: 0, skipped: {}, headers: [], idx: {} } };

  const headers = lines[0].split('\t').map(clean);

  const find = (...names) => {
    for (const n of names) {
      const i = headers.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };

  const idx = {
    sku: find('出品者SKU', 'seller-sku'),
    asin: find('商品ID', 'asin1', 'product-id'),
    name: find('商品名', 'item-name'),
    price: find('価格', 'price'),
    quantity: find('数量', 'quantity'),
    stockQty: find('在庫数', 'afn-fulfillable-quantity'),
    channel: find('フルフィルメント・チャンネル', 'fulfillment-channel'),
    status: find('ステータス', 'status'),
    openDate: find('出品日', 'open-date', 'listing-creation-date'), // ★追加
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

    // ★ openDate のパース（例: "2024-03-15 10:30:00 PDT" / "2024-03-15" 等の多様な形式に対応）
    const openDateRaw = idx.openDate >= 0 ? cols[idx.openDate] : '';
    const openDate = normalizeDate(openDateRaw);

    skus.push({
      sku,
      asin,
      name: (idx.name >= 0 ? cols[idx.name] : '').substring(0, 80),
      price,
      quantity,
      channel,
      openDate, // ★追加
    });
  }

  return {
    skus,
    debug: {
      totalRows: lines.length - 1,
      skipped,
      headers,
      idx,
      sampleOpenDates: skus.slice(0, 3).map(s => ({ sku: s.sku, openDate: s.openDate })),
    },
  };
}

// 日付文字列を ISO 8601 風の文字列に正規化（ソート可能な形式）
function normalizeDate(raw) {
  if (!raw) return null;
  // タイムゾーン文字列（PDT, JST等）を除去
  const cleaned = raw.replace(/\s*(PDT|PST|JST|UTC|GMT)\s*$/, '').trim();
  // "2024-03-15" / "2024-03-15 10:30:00" / "2024/03/15" 等を解釈
  const d = new Date(cleaned.replace(/\//g, '-'));
  if (isNaN(d.getTime())) return raw; // パース失敗時は元の文字列を保持（後続のソートで文字列比較）
  return d.toISOString();
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
