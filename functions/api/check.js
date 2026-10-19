export async function onRequestPost({ request, env }) {
  try {
    const { skus } = await request.json();
    if (!Array.isArray(skus) || skus.length === 0) {
      return json({ error: 'SKUリストが空' }, 400);
    }
    if (skus.length > 20) {
      return json({ error: '一度に20件まで' }, 400);
    }
    
    const token = await getAccessToken(env);
    const results = [];
    
    for (const sku of skus) {
      try {
        const data = await getListingInfo(env, token, sku);
        results.push({ sku, ...data, status: 'ok' });
      } catch (e) {
        results.push({ sku, status: 'error', error: e.message.substring(0, 80) });
      }
      await sleep(300);
    }
    return json(results);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function getListingInfo(env, token, sku) {
  const marketplaceId = 'A1VC38T7YXB528';
  const sellerId = env.SP_SELLER_ID;
  
  const listingUrl = `https://sellingpartnerapi-fe.amazon.com/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}?marketplaceIds=${marketplaceId}&includedData=offers,summaries,attributes`;
  const listingRes = await fetch(listingUrl, {
    headers: { 'x-amz-access-token': token }
  });
  
  if (!listingRes.ok) {
    const err = await listingRes.text();
    throw new Error(`Listing ${listingRes.status}: ${err.substring(0, 60)}`);
  }
  
  const listingData = await listingRes.json();
  const myPrice = Math.round(parseFloat(listingData.offers?.[0]?.price?.amount || 0));
  const asin = listingData.summaries?.[0]?.asin;
  const name = listingData.summaries?.[0]?.itemName || '';
  
  if (!asin) throw new Error('ASIN取得失敗');
  
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
    
    const buyBoxOffer = offers.find(o => o.IsBuyBoxWinner);
    if (buyBoxOffer) {
      cartPrice = Math.round(buyBoxOffer.ListingPrice?.Amount || 0);
      hasBuyBox = buyBoxOffer.SellerId === env.SP_SELLER_ID;
    }
    
    const summary = pricingData.payload?.Summary;
    const lowestOffers = summary?.LowestPrices || [];
    const newLowest = lowestOffers.find(l => l.condition === 'New');
    if (newLowest) {
      lowestPrice = Math.round(newLowest.LandedPrice?.Amount || 0);
    }
  }
  
  return {
    name: name.substring(0, 60),
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

const sleep = ms => new Promise(r => setTimeout(r, ms));
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
