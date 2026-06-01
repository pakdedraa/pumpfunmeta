// GET /api/pumpfun?limit=&sort=&order=&nsfw= -> { ok:true, tokens:[ {ca,name,symbol,...} ] }
// Proxies pump.fun frontend API and MAPS each coin to the exact field names that
// providers.js#pumpFunToFeedToken reads. If pump.fun blocks us -> { ok:true, tokens:[] }. Cache 5s.

import { fetchJson } from '../lib/rpc.js';
import { cached } from '../lib/cache.js';

// pump.fun rotates / retires frontend hosts (the legacy `frontend-api.pump.fun`
// now answers HTTP 530). Try the current v3 host first, then older hosts as
// fallback — all share the same `/coins?offset&limit&sort&order&includeNsfw`
// response shape, so mapCoin() works unchanged for whichever one answers.
const PUMP_HOSTS = [
  'https://frontend-api-v3.pump.fun',
  'https://frontend-api-v2.pump.fun',
  'https://frontend-api.pump.fun'
];
const TTL_MS = 5_000;

// Map one raw pump.fun coin to the feed-token field names the frontend expects.
function mapCoin(coin) {
  const mint = coin?.mint || coin?.ca;
  if (!mint) return null;

  const createdAt = Number(coin.created_timestamp || coin.createdTimestamp || 0) || null;
  const ageSeconds = createdAt ? Math.max(0, Math.floor((Date.now() - createdAt) / 1000)) : null;
  const completed = Boolean(coin.complete || coin.completed);

  // pump.fun exposes a "bonding curve progress"-ish signal via reserves or a direct field.
  let bondingCurveProgress = Number(coin.bonding_curve_progress ?? coin.progress ?? 0);
  if (!bondingCurveProgress && coin.usd_market_cap) {
    // Rough proxy: ~$69k mc completes the curve.
    bondingCurveProgress = Math.min(100, Math.round((Number(coin.usd_market_cap) / 69000) * 100));
  }

  return {
    ca: mint,
    name: coin.name || null,
    symbol: coin.symbol || null,
    marketCapSol: Number(coin.market_cap ?? coin.marketCapSol ?? 0),
    usdMarketCap: Number(coin.usd_market_cap ?? coin.usdMarketCap ?? 0),
    ageSeconds,
    bondingCurveProgress,
    completed,
    creator: coin.creator || coin.dev || null,
    replies: Number(coin.reply_count ?? coin.replies ?? 0),
    website: coin.website || null,
    twitter: coin.twitter || null,
    telegram: coin.telegram || null,
    url: `https://pump.fun/coin/${mint}`,
    createdAt
  };
}

// Reusable fetch+map (used by alpha.js too). Returns an array (possibly empty).
export async function fetchPumpFunCoins({ limit = 30, sort = 'created_timestamp', order = 'DESC', nsfw = false } = {}) {
  const params = new URLSearchParams({
    offset: '0',
    limit: String(limit),
    sort,
    order,
    includeNsfw: String(Boolean(nsfw))
  });
  const key = `pumpfun:${params.toString()}`;
  return cached(key, TTL_MS, async () => {
    const headers = {
      // Some pump.fun edges 403 without a browser-ish UA/origin.
      'user-agent': 'Mozilla/5.0 (compatible; MemeAgent/1.0)',
      origin: 'https://pump.fun',
      referer: 'https://pump.fun/'
    };
    for (const host of PUMP_HOSTS) {
      try {
        const data = await fetchJson(`${host}/coins?${params.toString()}`, { headers });
        const list = Array.isArray(data) ? data : (Array.isArray(data?.coins) ? data.coins : []);
        const mapped = list.map(mapCoin).filter(Boolean);
        if (mapped.length) return mapped; // first host that returns tokens wins
      } catch {
        // host blocked / down (e.g. 530) — fall through to the next one
      }
    }
    return []; // all hosts down — caller degrades gracefully
  });
}

export default async function pumpfunRoutes(fastify) {
  fastify.get('/api/pumpfun', async (request) => {
    const q = request.query || {};
    const tokens = await fetchPumpFunCoins({
      limit: Math.min(Number(q.limit || 30) || 30, 100),
      sort: String(q.sort || 'created_timestamp'),
      order: String(q.order || 'DESC'),
      nsfw: /^(1|true|yes)$/i.test(String(q.nsfw || ''))
    });
    return { ok: true, tokens };
  });
}
