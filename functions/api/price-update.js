// File: functions/api/price-update.js
export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { sku, newPrice } = body;

    // バリデーション
    if (!sku || typeof sku !== 'string') {
      return json({ ok: false, error: 'sku required' }, 400);
    }
    const price = parseFloat(newPrice);
    if (!price || price <= 0 || price > 9999999) {
      return json({ ok: false, error: 'newPrice must be positive and <= 9999999' }, 400);
    }
    // 整数円に丸め
    const priceInt = Math.round(price);

    const sellerId = env.SP_SELLER_ID;
    if (!sellerId) return json({ ok: false, error: 'SP_SELLER_ID not configured' }, 500);

    const token = await getAccessToken(env);
    const marketplaceId = 'A1VC38T7YXB528'; // 日本

    // Listings Items API PATCH
    // https://developer-docs.amazon.com/sp-api/docs/listings-items-api-v2021-08-01-reference
    const endpoint = `https://sellingpartnerapi-fe.amazon.com/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?marketplaceIds=${marketplaceId}`;

    const patchBody = {
      productType: 'PRODUCT',
      patches: [
        {
          op: 'replace',
          path: '/attributes/purchasable_offer',
          value: [
            {
              marketplace_id: marketplaceId,
              currency: 'JPY',
              our_price: [
                {
                  schedule: [
                    { value_with_tax: priceInt }
                  ]
                }
              ]
            }
          ]
        }
      ]
    };

    const res = await fetch(endpoint, {
      method: 'PATCH',
      headers: {
        'x-amz-access-token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(patchBody),
    });

    const resText = await res.text();
    let resData = {};
    try { resData = JSON.parse(resText); } catch(e) {}

    if (!res.ok) {
      return json({
        ok: false,
        sku,
        newPrice: priceInt,
        httpStatus: res.status,
        error: resData.errors ? JSON.stringify(resData.errors) : resText.substring(0, 500),
      }, 200); // フロント側で個別エラー処理できるよう200で返す
    }

    // 成功判定（Listings APIは submissionId を返す。即時反映ではない）
    return json({
      ok: true,
      sku,
      newPrice: priceInt,
      submissionId: resData.submissionId || null,
      status: resData.status || 'ACCEPTED',
      message: '価格変更を受付けました（反映まで数秒〜数分）',
    });
  } catch (e) {
    return json({ ok: false, error: e.message, stack: e.stack }, 500);
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
