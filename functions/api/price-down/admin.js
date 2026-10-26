// File: functions/api/price-down/admin.js
//
// 管理画面（price-down.html）用の統合API。
// 認証は既存の _middleware.ts のCookie認証を通過する前提。

import { executeGroup, calculateNextRunAt } from './executor.js';

const ADMIN_CONFIG = {
  INTERVAL_HOURS: 6,
  RANDOM_MINUTES: 15,
  IMMEDIATE_BLOCK_MINUTES: 10,   // 即時実行ブロック期間（分）
  LOG_LIMIT_DEFAULT: 50,          // ログ取得デフォルト件数
  LOG_LIMIT_MAX: 500,
};

// ========== GET ==========
export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: 'DB binding not configured' }, 500);

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'groups') {
    return await getGroups(env);
  }
  if (action === 'targets') {
    const groupId = parseInt(url.searchParams.get('group_id'), 10);
    if (!groupId || groupId < 1 || groupId > 3) {
      return json({ error: 'invalid group_id' }, 400);
    }
    return await getTargets(env, groupId);
  }
  if (action === 'logs') {
    const groupId = url.searchParams.get('group_id');
    const limitRaw = parseInt(url.searchParams.get('limit'), 10);
    const limit = Math.min(
      Math.max(limitRaw || ADMIN_CONFIG.LOG_LIMIT_DEFAULT, 1),
      ADMIN_CONFIG.LOG_LIMIT_MAX
    );
    return await getLogs(env, groupId ? parseInt(groupId, 10) : null, limit);
  }

  return json({ error: 'unknown action' }, 400);
}

// ========== POST ==========
export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.DB) return json({ error: 'DB binding not configured' }, 500);

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'targets') {
    const body = await safeJson(request);
    return await addTargets(env, body);
  }
  if (action === 'run_now') {
    const body = await safeJson(request);
    return await runNow(env, waitUntil, body);
  }
  if (action === 'stop_all') {
    return await stopAll(env);
  }

  return json({ error: 'unknown action' }, 400);
}

// ========== PUT ==========
export async function onRequestPut({ request, env }) {
  if (!env.DB) return json({ error: 'DB binding not configured' }, 500);

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'groups') {
    const body = await safeJson(request);
    return await updateGroup(env, body);
  }

  return json({ error: 'unknown action' }, 400);
}

// ========== DELETE ==========
export async function onRequestDelete({ request, env }) {
  if (!env.DB) return json({ error: 'DB binding not configured' }, 500);

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'targets') {
    const body = await safeJson(request);
    return await deleteTarget(env, body);
  }

  return json({ error: 'unknown action' }, 400);
}

// ====================================================
// グループ関連
// ====================================================

async function getGroups(env) {
  const { results } = await env.DB.prepare(
    `SELECT group_id, price_down_amount, is_active, is_running,
            next_run_at, last_run_at, updated_at
     FROM price_down_groups
     ORDER BY group_id ASC`
  ).all();

  // 各グループのSKU件数も取得
  const { results: counts } = await env.DB.prepare(
    `SELECT group_id, COUNT(*) as sku_count
     FROM price_down_targets
     GROUP BY group_id`
  ).all();

  const countMap = {};
  for (const c of counts || []) countMap[c.group_id] = c.sku_count;

  const groups = (results || []).map((g) => ({
    ...g,
    sku_count: countMap[g.group_id] || 0,
    is_active: !!g.is_active,
    is_running: !!g.is_running,
  }));

  return json({ ok: true, groups });
}

async function updateGroup(env, body) {
  const groupId = parseInt(body?.group_id, 10);
  if (!groupId || groupId < 1 || groupId > 3) {
    return json({ error: 'invalid group_id' }, 400);
  }

  const updates = [];
  const binds = [];

  if (body.price_down_amount !== undefined) {
    const amount = parseInt(body.price_down_amount, 10);
    if (isNaN(amount) || amount < 0 || amount > 999999) {
      return json({ error: 'price_down_amount must be 0-999999' }, 400);
    }
    updates.push('price_down_amount = ?');
    binds.push(amount);
  }

  if (body.is_active !== undefined) {
    const active = body.is_active ? 1 : 0;
    updates.push('is_active = ?');
    binds.push(active);

    // 稼働ONにする時、next_run_atが未設定または過去なら今から計算
    if (active === 1) {
      const nextRunAt = calculateNextRunAt(
        null,
        ADMIN_CONFIG.INTERVAL_HOURS,
        ADMIN_CONFIG.RANDOM_MINUTES
      );
      updates.push('next_run_at = ?');
      binds.push(nextRunAt);
    }
  }

  if (updates.length === 0) {
    return json({ error: 'no fields to update' }, 400);
  }

  updates.push('updated_at = ?');
  binds.push(new Date().toISOString());

  binds.push(groupId);

  await env.DB.prepare(
    `UPDATE price_down_groups SET ${updates.join(', ')} WHERE group_id = ?`
  ).bind(...binds).run();

  return json({ ok: true });
}

async function stopAll(env) {
  await env.DB.prepare(
    `UPDATE price_down_groups
     SET is_active = 0, updated_at = ?`
  ).bind(new Date().toISOString()).run();

  return json({ ok: true, message: 'All groups stopped' });
}

// ====================================================
// SKU（対象）関連
// ====================================================

async function getTargets(env, groupId) {
  const { results } = await env.DB.prepare(
    `SELECT id, sku, added_at
     FROM price_down_targets
     WHERE group_id = ?
     ORDER BY id ASC`
  ).bind(groupId).all();

  return json({ ok: true, group_id: groupId, targets: results || [] });
}

async function addTargets(env, body) {
  const groupId = parseInt(body?.group_id, 10);
  if (!groupId || groupId < 1 || groupId > 3) {
    return json({ error: 'invalid group_id' }, 400);
  }

  // skus は配列 or 改行区切り文字列を受け付ける
  let skus = [];
  if (Array.isArray(body.skus)) {
    skus = body.skus;
  } else if (typeof body.skus === 'string') {
    skus = body.skus.split(/\r?\n/);
  } else if (typeof body.sku === 'string') {
    skus = [body.sku];
  }

  // 整形: trim、空文字除去、重複除去
  skus = [...new Set(
    skus.map((s) => String(s).trim()).filter((s) => s.length > 0 && s.length <= 100)
  )];

  if (skus.length === 0) {
    return json({ error: 'no valid skus' }, 400);
  }
  if (skus.length > 500) {
    return json({ error: 'too many skus (max 500 per request)' }, 400);
  }

  const addedAt = new Date().toISOString();
  let added = 0;
  let skipped = 0;

  // 1件ずつINSERT（重複はUNIQUE制約で弾かれる）
  for (const sku of skus) {
    try {
      await env.DB.prepare(
        `INSERT INTO price_down_targets (group_id, sku, added_at) VALUES (?, ?, ?)`
      ).bind(groupId, sku, addedAt).run();
      added++;
    } catch (err) {
      // UNIQUE制約違反 = 既に存在
      skipped++;
    }
  }

  return json({ ok: true, added, skipped, total: skus.length });
}

async function deleteTarget(env, body) {
  const groupId = parseInt(body?.group_id, 10);
  if (!groupId || groupId < 1 || groupId > 3) {
    return json({ error: 'invalid group_id' }, 400);
  }

  // id指定削除 または sku指定削除 または all削除
  if (body.id) {
    const id = parseInt(body.id, 10);
    await env.DB.prepare(
      `DELETE FROM price_down_targets WHERE id = ? AND group_id = ?`
    ).bind(id, groupId).run();
    return json({ ok: true, deleted: 'by id' });
  }

  if (body.sku) {
    await env.DB.prepare(
      `DELETE FROM price_down_targets WHERE sku = ? AND group_id = ?`
    ).bind(String(body.sku), groupId).run();
    return json({ ok: true, deleted: 'by sku' });
  }

  if (body.all === true) {
    const res = await env.DB.prepare(
      `DELETE FROM price_down_targets WHERE group_id = ?`
    ).bind(groupId).run();
    return json({ ok: true, deleted: 'all', count: res.meta?.changes || 0 });
  }

  return json({ error: 'id, sku, or all=true required' }, 400);
}

// ====================================================
// ログ関連
// ====================================================

async function getLogs(env, groupId, limit) {
  let query, binds;

  if (groupId) {
    query = `SELECT id, group_id, sku, old_price, new_price, status, message,
                    duration_ms, executed_at
             FROM price_down_logs
             WHERE group_id = ?
             ORDER BY executed_at DESC
             LIMIT ?`;
    binds = [groupId, limit];
  } else {
    query = `SELECT id, group_id, sku, old_price, new_price, status, message,
                    duration_ms, executed_at
             FROM price_down_logs
             ORDER BY executed_at DESC
             LIMIT ?`;
    binds = [limit];
  }

  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return json({ ok: true, logs: results || [] });
}

// ====================================================
// 即時実行
// ====================================================

async function runNow(env, waitUntil, body) {
  const groupId = parseInt(body?.group_id, 10);
  if (!groupId || groupId < 1 || groupId > 3) {
    return json({ error: 'invalid group_id' }, 400);
  }

  // 10分以内の実行はブロック
  const { results: groups } = await env.DB.prepare(
    `SELECT group_id, price_down_amount, is_active, is_running, next_run_at, last_run_at
     FROM price_down_groups WHERE group_id = ?`
  ).bind(groupId).all();

  if (!groups || groups.length === 0) {
    return json({ error: 'group not found' }, 404);
  }

  const group = groups[0];

  if (!group.is_active) {
    return json({ error: 'group is not active (稼働停止中)' }, 400);
  }

  if (group.last_run_at) {
    const lastRunMs = new Date(group.last_run_at).getTime();
    const elapsedMin = (Date.now() - lastRunMs) / (60 * 1000);
    if (elapsedMin < ADMIN_CONFIG.IMMEDIATE_BLOCK_MINUTES) {
      const waitMin = Math.ceil(ADMIN_CONFIG.IMMEDIATE_BLOCK_MINUTES - elapsedMin);
      return json({
        error: `前回実行から${Math.floor(elapsedMin)}分しか経過していません。あと約${waitMin}分お待ちください`,
      }, 429);
    }
  }

  // ロック取得
  const lockResult = await env.DB.prepare(
    `UPDATE price_down_groups
     SET is_running = 1
     WHERE group_id = ? AND is_running = 0 AND is_active = 1`
  ).bind(groupId).run();

  if (lockResult.meta.changes !== 1) {
    return json({ error: 'group is already running or not active' }, 409);
  }

  // バックグラウンドで実行
  waitUntil(
    runGroupSafely(env, group).catch((err) => {
      console.error(`Immediate run group ${groupId} error:`, err);
    })
  );

  return json({ ok: true, message: `Group ${groupId} launched (background)` });
}

async function runGroupSafely(env, group) {
  const startedAt = new Date().toISOString();

  try {
    await executeGroup(env, group);
  } finally {
    const nextRunAt = calculateNextRunAt(
      group.next_run_at,
      ADMIN_CONFIG.INTERVAL_HOURS,
      ADMIN_CONFIG.RANDOM_MINUTES
    );

    await env.DB.prepare(
      `UPDATE price_down_groups
       SET is_running = 0,
           last_run_at = ?,
           next_run_at = ?,
           updated_at = ?
       WHERE group_id = ?`
    ).bind(
      startedAt,
      nextRunAt,
      new Date().toISOString(),
      group.group_id
    ).run();
  }
}

// ====================================================
// ユーティリティ
// ====================================================

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
