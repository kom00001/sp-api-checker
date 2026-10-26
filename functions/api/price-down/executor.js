// File: functions/api/price-down/executor.js
//
// 値下げ処理の中核ロジック。
// scheduled.js と admin.js の両方から呼び出される。

const EXECUTOR_CONFIG = {
  SKU_WAIT_MS: 1000,        // SKU間の待機時間（ミリ秒、SP-APIレート制限対策）
  MAX_SKU_PER_RUN: 10,      // 1回あたり最大処理SKU数（サブリクエスト上限50対策）
  MARKETPLACE_ID: 'A1VC38T7YXB528',  // 日本
};

/**
 * 指定グループの値下げ処理を実行
 * @param {object} env - Cloudflare env（DB, SP_* シークレット）
 * @param {object} group - { group_id, price_down_amount, ... }
 */
export async function executeGroup(env, group) {
  // 必須環境変数チェック
  const required = ['SP_SELLER_ID', 'SP_REFRESH_TOKEN', 'SP_LWA_APP_ID', 'SP_LWA_CLIENT_SECRET'];
  for (const key of required) {
    if (!env[key]) {
      throw new Error(`Environment variable ${key} is not configured`);
    }
  }

  const sellerId = env.SP_SELLER_ID;
  const priceDownAmount = group.price_down_amount;

  if (!priceDownAmount || priceDownAmount <= 0) {
    console.log(`Group ${group.group_id}: price_down_amount is 0 or invalid, skipping`);
    return;
  }

  // 対象SKU取得（上限MAX_SKU_PER_RUN件）
  const { results: targets } = await env.DB.prepare(
    `SELECT sku FROM price_down_targets
     WHERE group_id = ?
     ORDER BY id ASC
     LIMIT ?`
  ).bind(group.group_id, EXECUTOR_CONFIG.MAX_SKU_PER_RUN).all();

  if (!targets || targets.length === 0) {
    console.log(`Group ${group.group_id}: no target SKUs`);
    return;
  }

  // アクセストークンを1回だけ取得（全SKUで共有）
  const token = await getAccessToken(env);

  // 各SKUを順次処理
  for (let i = 0; i < targets.length; i++) {
    const sku = targets[i].sku;
    const startTime = Date.now();

    try {
      await processSku(env, token, sellerId, group.group_id, sku, priceDownAmount, startTime);
    } catch (err) {
      // 個別SKUのエラーは記録して継続
      await writeLog(env, {
        group_id: group.group_id,
        sku,
        old_price: null,
        new_price: null,
        status: 'error',
        message: err.message || String(err),
        duration_ms: Date.now() - startTime,
      });
    }

    // 最後のSKU以外は待機
    if (i < targets.length - 1) {
      await sleep(EXECUTOR_CONFIG.SKU_WAIT_MS);
    }
  }
}

/**
 * 1 SKUの処理（価格取得 → 計算 → 価格更新 → ログ記録）
 */
async function processSku(env, token, sellerId, groupId, sku, priceDownAmount, startTime) {
  // 現在価格を取得
  const currentPrice = await getCurrentPrice(token, sellerId, sku);

  if (currentPrice === null) {
    await writeLog(env, {
      group_id: groupId,
      sku,
      old_price: null,
      new_price: null,
      status: 'error',
      message: '現在価格が取得できません（出品停止・在庫切れの可能性）',
      duration_ms: Date.now() - startTime,
    });
    return;
  }

  const newPrice = currentPrice - priceDownAmount;

  if (newPrice <= 0) {
    await writeLog(env, {
      group_id: groupId,
      sku,
      old_price: currentPrice,
      new_price: newPrice,
      status: 'error',
      message: `新価格が0円以下になるためスキップ（${currentPrice} - ${priceDownAmount} = ${newPrice}）`,
      duration_ms: Date.now() - startTime,
    });
    return;
  }

  // 価格更新
  await updatePrice(token, sellerId, sku, newPrice);

  // 成功ログ
  await writeLog(env, {
    group_id: groupId,
    sku,
    old_price: currentPrice,
    new_price: newPrice,
    status: 'success',
    message: null,
    duration_ms: Date.now() - startTime,
  });
}

/**
 * SP-API Listings Items GET で現在の自分の出品価格を取得
 * @returns {number|null} 価格（円）、取得できなければnull
 */
async function getCurrentPrice(token, sellerId, sku) {
  const endpoint = `https://sellingpartnerapi-fe.amazon.com/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?marketplaceIds=${EXECUTOR_CONFIG.MARKETPLACE_ID}&includedData=offers`;

  const res = await fetch(endpoint, {
    method: 'GET',
    headers: {
      'x-amz-access-token': token,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`getCurrentPrice failed (HTTP ${res.status}): ${errText.substring(0, 300)}`);
  }

  const data = await res.json();

  // offers配列から価格を抽出
  if (!data.offers || !Array.isArray(data.offers) || data.offers.length === 0) {
    return null;
  }

  const offer = data.offers[0];
  const amount = offer?.price?.amount;

  if (amount === undefined || amount === null) {
    return null;
  }

  return Math.round(parseFloat(amount));
}

/**
 * SP-API Listings Items PATCH で価格更新
 * （price-update.js と同じ patchBody 構造）
 */
async function updatePrice(token, sellerId, sku, newPrice) {
  const endpoint = `https://sellingpartnerapi-fe.amazon.com/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?marketplaceIds=${EXECUTOR_CONFIG.MARKETPLACE_ID}`;

  const patchBody = {
    productType: 'PRODUCT',
    patches: [
      {
        op: 'replace',
        path: '/attributes/purchasable_offer',
        value: [
          {
            marketplace_id: EXECUTOR_CONFIG.MARKETPLACE_ID,
            currency: 'JPY',
            our_price: [
              {
                schedule: [
                  { value_with_tax: newPrice }
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

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`updatePrice failed (HTTP ${res.status}): ${errText.substring(0, 300)}`);
  }
}

/**
 * SP-API 用アクセストークン取得（LWA）
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
  if (!data.access_token) {
    throw new Error('LWA認証失敗: ' + (data.error_description || JSON.stringify(data)));
  }
  return data.access_token;
}

/**
 * D1 にログを書き込む
 */
async function writeLog(env, log) {
  await env.DB.prepare(
    `INSERT INTO price_down_logs
     (group_id, sku, old_price, new_price, status, message, duration_ms, executed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    log.group_id,
    log.sku,
    log.old_price,
    log.new_price,
    log.status,
    log.message,
    log.duration_ms,
    new Date().toISOString()
  ).run();
}

/**
 * 次回実行時刻を計算（予定時刻基準 + ランダム揺らぎ）
 * @param {string|null} prevNextRunAt - 前回の予定時刻（ISO8601 UTC）
 * @param {number} intervalHours - 基本間隔（時間）
 * @param {number} randomMinutes - ランダム揺らぎ幅（±分）
 * @returns {string} 次回実行時刻（ISO8601 UTC）
 */
export function calculateNextRunAt(prevNextRunAt, intervalHours, randomMinutes) {
  const now = Date.now();
  let baseMs;

  if (prevNextRunAt) {
    baseMs = new Date(prevNextRunAt).getTime();
    // 予定時刻が過去すぎる場合（長時間停止後など）は現在時刻を基準に
    if (baseMs < now - 60 * 1000) {
      baseMs = now;
    }
  } else {
    baseMs = now;
  }

  // 基本間隔を加算
  const nextMs = baseMs + intervalHours * 60 * 60 * 1000;

  // ランダム揺らぎを加算（±randomMinutes分）
  const randomOffsetMs = (Math.random() * 2 - 1) * randomMinutes * 60 * 1000;

  return new Date(nextMs + randomOffsetMs).toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
