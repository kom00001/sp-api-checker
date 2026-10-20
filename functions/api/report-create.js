export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const reportType = body.reportType || 'ALL';

    // レポートタイプのマッピング
    const reportTypeMap = {
      ALL: 'GET_MERCHANT_LISTINGS_ALL_DATA',  // 全出品（FBA+FBM）
      FBM: 'GET_MERCHANT_LISTINGS_DATA',       // 自己発送のみ
      FBA: 'GET_FBA_MYI_ALL_INVENTORY_DATA',   // FBA在庫
    };

    const spReportType = reportTypeMap[reportType];
    if (!spReportType) {
      return json({ error: 'reportType must be ALL, FBA, or FBM' }, 400);
    }

    const token = await getAccessToken(env);
    const marketplaceId = 'A1VC38T7YXB528';

    const createRes = await fetch(
      'https://sellingpartnerapi-fe.amazon.com/reports/2021-06-30/reports',
      {
        method: 'POST',
        headers: {
          'x-amz-access-token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reportType: spReportType,
          marketplaceIds: [marketplaceId],
        }),
      }
    );

    if (!createRes.ok) {
      const errText = await createRes.text();
      return json(
        { error: `Report create failed: ${createRes.status}`, detail: errText.substring(0, 200) },
        500
      );
    }

    const data = await createRes.json();
    if (!data.reportId) {
      return json({ error: 'reportId missing in response' }, 500);
    }

    return json({
      reportId: data.reportId,
      reportType,
      spReportType,
    });
  } catch (e) {
    return json({ error: e.message }, 500);
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
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
