// File: functions/api/check.js

export async function onRequestPost({ request, env }) {
  try {
    const { skus } = await request.json();
    
    // バリデーション
    if (!Array.isArray(skus) || skus.length === 0) {
      return json({ error: 'SKUリストが空です' }, 400);
    }
    if (skus.length > 20) {
      return json({ error: '一度にチェックできるのは20件までです' }, 400);
    }

    // 1. Amazon Access Tokenを取得
    const token = await getAccessToken(env);
    const results = [];

    // 2. 各SKUの情報を順番に取得
    for (const sku of skus) {
      try {
        const data = await getListingInfo(env, token, sku);
        results.push({ sku, ...data, status: 'ok' });
      } catch (e) {
        // 個別エラー時はそのSKUのみエラーとして記録
        results.push({ 
          sku, 
          status: 'error', 
          error: e.message.substring(0, 80) 
        });
      }
      // APIレート制限（スロットリング）回避のため少し待機 (300ms)
      await new Promise(r => setTimeout(r, 300));
    }

    return json(results);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

/**
 * SKUから出品情報と競合価格を取得するメインロジック
 */
async function getListingInfo(env, token, sku) {
  const marketplaceId = 'A1VC38T7YXB528'; // 日本
  const sellerId = env.SP_SELLER_ID;

  // --- A. Listing情報の取得 (自分の価格とASINを取得) ---
  const listingUrl = `https://sellingpartnerapi-fe.amazon.com/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}?marketplaceIds=${marketplaceId}&includedData=offers,summaries,attributes`;
  const listingRes = await fetch(listingUrl, {
    headers: { 'x-amz-access-token': token }
  });

  if (!listingRes.ok) {
    const errText = await listingRes.text();
    throw new Error(`Amazon Listing API Error: ${listingRes.status}`);
  }

  const listingData = await listingRes.ok ? await listingRes.json() : null;
  const myPrice = Math.round(parseFloat(listingData?.offers?.[0]?.price?.amount || 0));
  const asin = listingData?.summaries?.[0]?.asin;
  const itemName = listingData?.summaries?.[0]?.itemName || '';

  if (!asin) throw new Error('ASINの取得に失敗しました');

  // --- B. 競合価格情報の取得 (カート価格と最安値を取得) ---
  const pricingUrl = `https://sellingpartnerapi-fe.amazon.com/products/pricing/v0/items/${asin}/offers?MarketplaceId=${marketplaceId}&ItemCondition=New`;
  const pricingRes = await fetch(pricingUrl, {
    headers: { 'x-amz-access-token': token }
  });

  let cartPrice = null;
  let lowestPrice = null;
  let competitorCount = 0;
  let hasBuyBox = false;

  if (pricingRes.ok) {
    const pricingData = await pricingRes.json();
    const offers = pricingData.payload?.Offers || [];
    competitorCount = offers.length;

    // カート獲得者（BuyBox）の特定
    const buyBoxOffer = offers.find(o => o.IsBuyBoxWinner);
    if (buyBoxOffer) {
      cartPrice = Math.round(buyBoxOffer.ListingPrice?.Amount || 0);
      // 自分のSellerIdとカート獲得者のSellerIdが一致するか判定
      hasBuyBox = buyBoxOffer.SellerId === env.SP_SELLER_ID;
    }

    // 最安値の取得
    const summary = pricingData.payload?.Summary;
    const lowestOffers = summary?.LowestPrices || [];
    const newLowest = lowestOffers.find(l => l.condition === 'New');
    if (newLowest) {
      lowestPrice = Math.round(newLowest.LandedPrice?.Amount || 0);
    }
  }

  return {
    name: itemName.substring(0, 60),
    asin,
    myPrice,
    cartPrice,
    lowestPrice,
    hasBuyBox,
    competitorCount,
    diffFromCart: cartPrice ? myPrice - cartPrice : null,
    diffFromLowest: lowestPrice ? myPrice - lowestPrice : null,
  };
}

/**
 * Amazon LWA Access Tokenの取得
 */
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
  if (!data.access_token) throw new Error('Access Tokenの取得に失敗しました');
  return data.access_token;
}

/**
 * レスポンス用ヘルパー
 */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
