// File: functions/api/price-down/scheduled.js
//
// GitHub Actionsから15分おきに叩かれるCron受け口。
// X-Cron-Secretヘッダーで認証し、実行時刻を迎えたグループの値下げ処理を起動する。
// 間隔・揺らぎはD1のpice_down_groupsテーブルの各グループ設定を使用。

import { executeGroup, calculateNextRunAt } from './executor.js';

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;

  // ===== 1. 認証チェック =====
  const providedSecret = request.headers.get('X-Cron-Secret');
  if (!env.CRON_SECRET) {
    return jsonResponse({ error: 'CRON_SECRET not configured' }, 500);
  }
  if (providedSecret !== env.CRON_SECRET) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  // ===== 2. D1接続チェック =====
  if (!env.DB) {
    return jsonResponse({ error: 'DB binding not configured' }, 500);
  }

  // ===== 3. 実行対象グループを探す =====
  const nowIso = new Date().toISOString();

  const { results: dueGroups } = await env.DB.prepare(
    `SELECT group_id, price_down_amount, interval_hours, random_minutes,
            next_run_at, last_run_at
     FROM price_down_groups
     WHERE is_active = 1
       AND is_running = 0
       AND (next_run_at IS NULL OR next_run_at <= ?)`
  ).bind(nowIso).all();

  if (!dueGroups || dueGroups.length === 0) {
    return jsonResponse({
      ok: true,
      message: 'No groups due for execution',
      checkedAt: nowIso,
    });
  }

  // ===== 4. 各対象グループを処理（バックグラウンド実行） =====
  const launched = [];

  for (const group of dueGroups) {
    const lockResult = await env.DB.prepare(
      `UPDATE price_down_groups
       SET is_running = 1
       WHERE group_id = ? AND is_running = 0 AND is_active = 1`
    ).bind(group.group_id).run();

    if (lockResult.meta.changes !== 1) {
      continue;
    }

    launched.push(group.group_id);

    waitUntil(
      runGroupSafely(env, group).catch((err) => {
        console.error(`Group ${group.group_id} execution error:`, err);
      })
    );
  }

  // ===== 5. 即座にレスポンス返却 =====
  return jsonResponse({
    ok: true,
    message: `Launched ${launched.length} group(s)`,
    launchedGroupIds: launched,
    checkedAt: nowIso,
  });
}

// GET も許可（手動確認用、認証は同じ）
export const onRequestGet = onRequestPost;

/**
 * グループ処理を安全に実行し、必ずロック解放と次回時刻計算を行う
 * 間隔・揺らぎはgroup自身の値を使用（DB管理）
 */
async function runGroupSafely(env, group) {
  const startedAt = new Date().toISOString();

  try {
    await executeGroup(env, group);
  } finally {
    const nextRunAt = calculateNextRunAt(
      group.next_run_at,
      group.interval_hours || 6,
      group.random_minutes != null ? group.random_minutes : 15
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

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
