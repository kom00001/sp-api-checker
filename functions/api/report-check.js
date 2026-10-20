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
      {
        headers: { 'x-amz-access-token': token },
      }
    );

    if (!statusRes.ok) {
      const errText = await statusRes.text();
      return json(
        { status: 'FAILED', error: `Status check ${statusRes.status}: ${errText.substring(0, 200)}` },
        500
      );
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
    if (!documentId) {
      return json({ status: 'FAILED', error: 'reportDocumentId missing' }, 500);
    }

    const docRes = await fetch(
      `https://sellingpartnerapi-fe.amazon.com/reports/2021-06-30/documents/${documentId}`,
      {
        headers: { 'x-amz-access-token': token },
      }
    );

    if (!docRes.ok) {
      const errText = await docRes.text();
      return json(
        { status: 'FAILED', error: `Document fetch ${docRes.status}: ${errText.substring(0, 200)}` },
        500
      );
    }

    const docData = await docRes.json();
    const downloadUrl = docData.url;
    const compressionAlgorithm = docData.compressionAlgorithm;

    const reportRes = await fetch(downloadUrl);
    if (!reportRes.ok) {
      return json({ status: 'FAILED', error: `Download failed: ${reportRes.status}` }, 500);
    }

    let reportText;
    if (compressionAlgorithm === 'GZIP') {
      const stream = reportRes.body.pipeThrough(new DecompressionStream('gzip'));
      const decompressed = await new Response(stream).arrayBuffer();
      reportText = new TextDecoder('shift_jis').decode(decompressed);
    } else {
      const buf = await reportRes.arrayBuffer();
      reportText = new TextDecoder('shift_jis').decode(buf);
    }

    const skus = parseReport(reportText);

    const payload = {
      updated: new Date().toISOString(),
      count: skus.length,
      summary: summarize(skus),
      skus,
    };

    await env.SKU_CACHE.put('sku_list', JSON.stringify(payload), {
      expirationTtl: 60 * 60 * 24 * 7,
    });

    return json({
      status: 'DONE',
      count: skus.length,
      summary: payload.summary,
    });
  } catch (e) {
    return json({ status: 'FAILED', error: e.message }, 500);
  }
}

function parseReport(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split('\t');

  const idx = {
    sku: headers.indexOf('seller-sku'),
    asin: headers.indexOf('asin1'),
    name: headers.indexOf('item-name'),
    price: headers.indexOf('price'),
    quantity: headers.indexOf('quantity'),
    channel: headers.indexOf('fulfillment-channel'),
    status: headers.indexOf('status'),
  };

  const skus = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < headers.length) continue;

    const status = idx.status >= 0 ? cols[idx.status] : 'Active';
    if (status && status !== 'Active') continue;

    const asin = idx.asin >= 0 ? cols[idx.asin] : '';
    if (!asin) continue;

    const channelRaw = idx.channel >= 0 ? cols[idx.channel] : '';
    const channel = channelRaw === 'DEFAULT' ? 'FBM' : (channelRaw ? 'FBA' : 'FBM');

    skus.push({
      sku: cols[idx.sku] || '',
      asin,
      name: (cols[idx.name] || '').substring(0, 80),
      price: parseFloat(cols[idx.price] || '0') || 0,
      quantity: parseInt(cols[idx.quantity] || '0', 10) || 0,
      channel,
      status: 'Active',
    });
  }

  return skus;
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
