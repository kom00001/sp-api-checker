// File: functions/api/image-fetch.js
// Catalog Items API で画像URLを取得し、KVの sku_list に imageUrl を追記保存
// クライアントから batchIndex を指定してポーリング形式で呼び出す

export async function onRequestPost({ request, env }) {
  try {
    if (!env.SKU_CACHE) {
      return json({ ok: false, error: 'KV binding SKU_CACHE not found' }, 500);
    }

    const body = await request.json();
    const batchIndex = parseInt(body.batchIndex || 0, 10);
    const batchSize = 20; // Catalog Items APIの最大

    // KVから現在の sku_list を取得
    const raw = await env.SKU_CACHE.get('sku_list');
    if (!raw) {
      return json({ ok: false, error: 'sku_list not found. Run report-check first.' }, 404);
    }

    const data = JSON.parse(raw);
    const skus = Array.isArray(data.skus) ? data.skus : [];
    const totalBatches = Math.ceil(skus.length / batchSize);

    if (batchIndex >= totalBatches) {
      return json({ ok: true, done: true, totalBatches, message: '全バッチ完了' });
    }

    // 対象バッチを抽出
    const start = batchIndex * batchSize;
    const end = Math.min(start + batchSize, skus.length);
    const batch = skus.slice(start, end);
    const asinList = batch.map(s => s.asin).filter(Boolean);

    if (asinList.length === 0) {
      return json({ ok: true, batchIndex, totalBatches, processed: 0, fetched: 0, nextBatch: batchIndex + 1 });
    }

    // Catalog Items API 呼び出し
    const token = await getAccessToken(env);
    const marketplaceId = 'A1VC38T7YXB528';
    const url = `https://sellingpartnerapi-fe.amazon.com/catalog/2022-04-01/items?identifiers=${encodeURIComponent(asinList.join(','))}&identifiersType=ASIN&marketplaceIds=${marketplaceId}&includedData=images`;

    const res = await fetch(url, {
      headers: { 'x-amz-access-token': token }
    });

    if (!res.ok) {
      const errText = await res.text();
      return json({
        ok: false,
        batchIndex,
        totalBatches,
        error: `Catalog API ${res.status}: ${errText.substring(0, 300)}`,
      }, 200);
    }

    const catalogData = await res.json();
    const items = catalogData.items || [];

    // ASIN -> imageUrl のマップを作成
    const imageMap = new Map();
    for (const item of items) {
      const asin = item.asin;
      // images配列から MAIN 画像を探す（marketplaceごとに配列）
      let imageUrl = null;
      if (Array.isArray(item.images) && item.images.length > 0) {
        for (const imgGroup of item.images) {
          if (Array.isArray(imgGroup.images)) {
            // MAIN variant を優先
            const mainImg = imgGroup.images.find(i => i.variant === 'MAIN');
            if (mainImg && mainImg.link) {
              imageUrl = mainImg.link;
              break;
            }
            // MAINがなければ最初の画像を使用
            if (imgGroup.images[0] && imgGroup.images[0].link) {
              imageUrl = imgGroup.images[0].link;
              break;
            }
          }
        }
      }
      if (imageUrl && asin) imageMap.set(asin, imageUrl);
    }

    // sku_list の該当SKUに imageUrl を追記（差分マージ）
    let updatedCount = 0;
    for (const skuItem of data.skus) {
      if (imageMap.has(skuItem.asin)) {
        skuItem.imageUrl = imageMap.get(skuItem.asin);
        updatedCount++;
      }
    }

    // KVに保存（全体を上書き）
    data.imageUpdated = new Date().toISOString();
    await env.SKU_CACHE.put('sku_list', JSON.stringify(data), {
      expirationTtl: 60 * 60 * 24 * 30, // 30日
    });

    const nextBatch = batchIndex + 1;
    const isLast = nextBatch >= totalBatches;

    return json({
      ok: true,
      batchIndex,
      totalBatches,
      processed: asinList.length,
      fetched: imageMap.size,
      updated: updatedCount,
      nextBatch: isLast ? null : nextBatch,
      done: isLast,
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
