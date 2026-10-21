// File: functions/api/sku-list.js
export async function onRequestGet({ request, env }) {
  try {
    // KVバインド確認（フェイルクローズ）
    if (!env.SKU_CACHE) {
      return json({ ok: false, error: 'KV binding SKU_CACHE not found' }, 500);
    }

    const url = new URL(request.url);
    const channel = (url.searchParams.get('channel') || '').toUpperCase().trim();
    const q = (url.searchParams.get('q') || '').trim();
    const limit = parseInt(url.searchParams.get('limit') || '0', 10) || 0;

    // channelバリデーション
    if (channel && channel !== 'FBA' && channel !== 'FBM' && channel !== 'ALL') {
      return json({ ok: false, error: 'channel must be FBA, FBM, or ALL' }, 400);
    }

    // KVから取得
    const raw = await env.SKU_CACHE.get('sku_list');
    if (!raw) {
      return json({
        ok: false,
        error: 'SKU list not found in KV. Run /api/report-create first.',
        hint: 'まず「🔄 SKU一覧を更新」を実行してください',
      }, 404);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return json({ ok: false, error: 'KV data corrupted: ' + e.message }, 500);
    }

    const allSkus = Array.isArray(data.skus) ? data.skus : [];
    const total = allSkus.length;

    // フィルタ処理
    let filtered = allSkus;

    // channelフィルタ（ALLまたは未指定なら素通し）
    if (channel && channel !== 'ALL') {
      filtered = filtered.filter((s) => s.channel === channel);
    }

    // qフィルタ（SKU・ASIN・商品名の部分一致、大文字小文字無視）
    if (q) {
      const qLower = q.toLowerCase();
      filtered = filtered.filter((s) => {
        return (s.sku || '').toLowerCase().includes(qLower) ||
               (s.asin || '').toLowerCase().includes(qLower) ||
               (s.name || '').toLowerCase().includes(qLower);
      });
    }

    // SKU順ソート
    filtered.sort((a, b) => (a.sku || '').localeCompare(b.sku || ''));

    // limit適用（0なら無制限）
    const items = limit > 0 ? filtered.slice(0, limit) : filtered;

    return json({
      ok: true,
      total,
      filtered: filtered.length,
      returned: items.length,
      channel: channel || 'ALL',
      query: q || null,
      updated: data.updated || null,
      summary: data.summary || null,
      items,
    });
  } catch (e) {
    return json({ ok: false, error: e.message, stack: e.stack }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
