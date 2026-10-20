export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const reportId = url.searchParams.get('id');

    if (!reportId) {
      return json({ error: 'id parameter required' }, 400);
    }

    const token = await getAccessToken(env);

    const statusRes = await fetch(
      `https://sellingpartnerapi-fe.amazon.com/reports/2021-06-30/reports/${reportId}`,
      { headers: { 'x-amz-access-token': token } }
    );

    const statusData = await statusRes.json();
    if (statusData.processingStatus !== 'DONE') {
      return json({ error: 'Report not DONE', statusData });
    }

    const documentId = statusData.reportDocumentId;
    const docRes = await fetch(
      `https://sellingpartnerapi-fe.amazon.com/reports/2021-06-30/documents/${documentId}`,
      { headers: { 'x-amz-access-token': token } }
    );

    const docData = await docRes.json();
    const reportRes = await fetch(docData.url);
    const compressionAlgorithm = docData.compressionAlgorithm;

    let reportBuffer;
    if (compressionAlgorithm === 'GZIP') {
      const stream = reportRes.body.pipeThrough(new DecompressionStream('gzip'));
      reportBuffer = await new Response(stream).arrayBuffer();
    } else {
      reportBuffer = await reportRes.arrayBuffer();
    }

    const reportText = new TextDecoder('utf-8').decode(reportBuffer);
    const lines = reportText.split(/\r?\n/).filter(l => l.trim());

    const headers = lines[0].split('\t');
    
    // ヘッダーインデックス
    const idx = {
      sku: headers.indexOf('出品者SKU'),
      asin: headers.indexOf('商品ID'),
      name: headers.indexOf('商品名'),
      price: headers.indexOf('価格'),
      quantity: headers.indexOf('数量'),
      stockQty: headers.indexOf('在庫数'),
      channel: headers.indexOf('フルフィルメント・チャンネル'),
      status: headers.indexOf('ステータス'),
    };

    // パース統計
    let stats = {
      totalLines: lines.length - 1,
      skippedShortCols: 0,
      skippedInactive: 0,
      skippedNoAsin: 0,
      inactiveStatuses: new Set(),
      channelValues: new Map(),
      statusValues: new Map(),
      passed: 0,
    };

    const samples = [];
    for (let i = 1; i < Math.min(lines.length, 11); i++) {
      const cols = lines[i].split('\t');
      samples.push({
        lineNum: i,
        colsCount: cols.length,
        headersCount: headers.length,
        statusValue: idx.status >= 0 ? JSON.stringify(cols[idx.status]) : 'IDX=-1',
        asinValue: idx.asin >= 0 ? JSON.stringify(cols[idx.asin]) : 'IDX=-1',
        skuValue: idx.sku >= 0 ? JSON.stringify(cols[idx.sku]) : 'IDX=-1',
        channelValue: idx.channel >= 0 ? JSON.stringify(cols[idx.channel]) : 'IDX=-1',
      });
    }

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t');

      if (cols.length < 5) {
        stats.skippedShortCols++;
        continue;
      }

      const status = idx.status >= 0 ? cols[idx.status] : 'Active';
      stats.statusValues.set(status, (stats.statusValues.get(status) || 0) + 1);

      if (status && status !== 'Active') {
        stats.skippedInactive++;
        stats.inactiveStatuses.add(status);
        continue;
      }

      const asin = idx.asin >= 0 ? cols[idx.asin] : '';
      if (!asin) {
        stats.skippedNoAsin++;
        continue;
      }

      const channelRaw = idx.channel >= 0 ? cols[idx.channel] : '';
      stats.channelValues.set(channelRaw, (stats.channelValues.get(channelRaw) || 0) + 1);

      stats.passed++;
    }

    return json({
      idx,
      stats: {
        totalLines: stats.totalLines,
        skippedShortCols: stats.skippedShortCols,
        skippedInactive: stats.skippedInactive,
        skippedNoAsin: stats.skippedNoAsin,
        passed: stats.passed,
        inactiveStatuses: [...stats.inactiveStatuses],
        statusValues: Object.fromEntries(stats.statusValues),
        channelValues: Object.fromEntries(stats.channelValues),
      },
      samples,
    });
  } catch (e) {
    return json({ error: e.message, stack: e.stack }, 500);
  }
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
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
