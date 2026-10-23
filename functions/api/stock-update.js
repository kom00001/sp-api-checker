// File: functions/api/stock-update.js
// FBM（自己配送）商品の在庫数変更API
export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { sku, quantity } = body;

    // バリデーション
    if (!sku || typeof sku !== 'string') {
      return json({ ok: false, error: 'sku required' }, 400);
    }
    const qty = parseInt(quantity, 10);
    if (isNaN(qty) || qty < 0 || qty > 999999) {
      return json({ ok: false, error: 'quantity must be 0 or positive integer (max 999999)' }, 400);
    }

    const sellerId = env.SP_SELLER_ID;
    if (!sellerId) return json({ ok: false, error: 'SP_SELLER_ID not configured' }, 500);

    const token = await getAccessToken(env);
    const marketplaceId = 'A1VC38T7YXB528'; // 日本

    // Listings Items API PATCH で在庫数変更
    const endpoint = `https://sellingpartnerapi-fe.amazon.com/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?marketplaceIds=${marketplaceId}`;

    const patchBody = {
      productType: 'PRODUCT',
      patches: [
        {
          op: 'replace',
          path: '/attributes/fulfillment_availability',
          value: [
            {
              fulfillment_channel_code: 'DEFAULT',
              quantity: qty,
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
        quantity: qty,
        httpStatus: res.status,
        error: resData.errors ? JSON.stringify(resData.errors) : resText.substring(0, 500),
      }, 200);
    }

    return json({
      ok: true,
      sku,
      quantity: qty,
      submissionId: resData.submissionId || null,
      status: resData.status || 'ACCEPTED',
      message: qty === 0 ? '出品停止を受付けました（反映まで数秒〜数分）' : '在庫変更を受付けました（反映まで数秒〜数分）',
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
