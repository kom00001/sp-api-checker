export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const reportId = url.searchParams.get('id');

    if (!reportId) {
      return json({ error: 'id parameter required' }, 400);
    }

    const token = await getAccessToken(env);

    // レポート状態確認
    const statusRes = await fetch(
      `https://sellingpartnerapi-fe.amazon.com/reports/2021-06-30/reports/${reportId}`,
      { headers: { 'x-amz-access-token': token } }
    );

    const statusData = await statusRes.json();
    if (statusData.processingStatus !== 'DONE') {
      return json({ error: 'Report not DONE', statusData });
    }

    const documentId = statusData.reportDocumentId;

    // ドキュメント情報取得
    const docRes = await fetch(
      `https://sellingpartnerapi-fe.amazon.com/reports/2021-06-30/documents/${documentId}`,
      { headers: { 'x-amz-access-token': token } }
    );

    const docData = await docRes.json();

    // レポート本体ダウンロード
    const reportRes = await fetch(docData.url);
    const compressionAlgorithm = docData.compressionAlgorithm;

    let reportBuffer;
    if (compressionAlgorithm === 'GZIP') {
      const stream = reportRes.body.pipeThrough(new DecompressionStream('gzip'));
      reportBuffer = await new Response(stream).arrayBuffer();
    } else {
      reportBuffer = await reportRes.arrayBuffer();
    }

    // 文字コード別にデコード試行
    const utf8Text = new TextDecoder('utf-8').decode(reportBuffer);
    const sjisText = new TextDecoder('shift_jis').decode(reportBuffer);

    const utf8Lines = utf8Text.split(/\r?\n/).filter(l => l.trim());
    const sjisLines = sjisText.split(/\r?\n/).filter(l => l.trim());

    return json({
      status: 'OK',
      compressionAlgorithm,
      bufferSize: reportBuffer.byteLength,
      utf8: {
        totalLines: utf8Lines.length,
        header: utf8Lines[0] || '(empty)',
        firstDataRow: utf8Lines[1] || '(empty)',
        headerColumns: (utf8Lines[0] || '').split('\t'),
      },
      sjis: {
        totalLines: sjisLines.length,
        header: sjisLines[0] || '(empty)',
        firstDataRow: sjisLines[1] || '(empty)',
        headerColumns: (sjisLines[0] || '').split('\t'),
      },
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
