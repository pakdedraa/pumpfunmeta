// alpha.js — small server-side alpha computation. Pulls recent pump.fun tokens,
// scores them on bonding progress / age / market cap / social signal, and (best effort)
// enriches the top picks with holder intel. Returns a ranked list of compact items
// each shaped { ca, ticker, phase, meta, alphaScore, riskVerdict }.

import { fetchPumpFunCoins } from '../routes/pumpfun.js';
import { fetchTopHolders } from './holders.js';
import { cached } from './cache.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Score a single mapped pump.fun token (0-100). Pure, no network.
export function scoreToken(t) {
  let score = 30;
  const progress = Number(t.bondingCurveProgress || 0);
  const ageSec = Number(t.ageSeconds || 0);
  const mcUsd = Number(t.usdMarketCap || 0);
  const replies = Number(t.replies || 0);

  // Sweet spot: bonding 30-85% — momentum but not yet topped out.
  if (progress >= 30 && progress <= 85) score += 22;
  else if (progress > 85) score += 8;
  else if (progress >= 10) score += 10;

  // Freshness: minutes-old tokens score higher, very old ones decay.
  if (ageSec > 0 && ageSec <= 1800) score += 16;
  else if (ageSec <= 7200) score += 8;
  else if (ageSec > 86400) score -= 10;

  // Market cap band: enough traction, not already mooned.
  if (mcUsd >= 8000 && mcUsd <= 120000) score += 14;
  else if (mcUsd > 120000) score += 4;

  // Social engagement.
  score += Math.min(replies / 5, 12);

  // Has at least one social link.
  if (t.twitter || t.telegram || t.website) score += 6;

  return clamp(Math.round(score), 0, 100);
}

// Map alphaScore + intel into a qualitative verdict.
export function riskVerdict(score, intel) {
  const top10 = intel?.top10Pct;
  if (top10 != null && top10 >= 70) return 'high-risk';
  if (intel?.commonFunderWallets != null && intel.commonFunderWallets >= 5) return 'high-risk';
  if (score >= 70) return 'watch';
  if (score >= 50) return 'neutral';
  return 'low-conviction';
}

export function phaseFor(t) {
  if (t.completed) return 'migrated';
  const progress = Number(t.bondingCurveProgress || 0);
  if (progress >= 60) return 'soon';
  return 'new';
}

// Build the ranked alpha list. `enrich` controls how many top items get holder intel.
async function computeAlpha({ limit = 12, enrich = 3 } = {}) {
  const coins = await fetchPumpFunCoins({ limit: 40, sort: 'created_timestamp', order: 'DESC', nsfw: false })
    .catch(() => []);

  const ranked = coins
    .map((t) => ({ token: t, alphaScore: scoreToken(t) }))
    .sort((a, b) => b.alphaScore - a.alphaScore)
    .slice(0, limit);

  // Enrich only the top N with holder intel to keep latency/cost bounded.
  const enriched = await Promise.all(
    ranked.map(async (entry, index) => {
      const t = entry.token;
      let intel = null;
      if (index < enrich && t.ca) {
        intel = await fetchTopHolders(t.ca).catch(() => null);
      }
      return {
        ca: t.ca,
        ticker: t.symbol || (t.ca ? t.ca.slice(0, 4).toUpperCase() : '????'),
        phase: phaseFor(t),
        meta: {
          name: t.name || null,
          marketCapUsd: Number(t.usdMarketCap || 0),
          marketCapSol: Number(t.marketCapSol || 0),
          bondingCurveProgress: Number(t.bondingCurveProgress || 0),
          ageSeconds: Number(t.ageSeconds || 0),
          replies: Number(t.replies || 0),
          completed: Boolean(t.completed),
          url: t.url || null,
          twitter: t.twitter || null,
          telegram: t.telegram || null,
          website: t.website || null,
          top10Pct: intel?.top10Pct ?? null,
          commonFunderWallets: intel?.commonFunderWallets ?? null,
          smartMoneyCount: intel?.smartMoneyCount ?? null,
          uniqueOwnerCount: intel?.uniqueOwnerCount ?? null
        },
        alphaScore: entry.alphaScore,
        riskVerdict: riskVerdict(entry.alphaScore, intel)
      };
    })
  );

  return enriched;
}

// Cached full alpha feed (15s) — the gated payload.
export function getAlphaFeed(opts = {}) {
  return cached('alpha:feed', 15_000, () => computeAlpha({ limit: 12, enrich: 3, ...opts }));
}

// Ungated teaser: top 1-2 items, no holder enrichment, slightly delayed cache (30s).
export function getAlphaPreview() {
  return cached('alpha:preview', 30_000, async () => {
    const list = await computeAlpha({ limit: 2, enrich: 0 });
    return list.map((item) => ({
      ca: item.ca,
      ticker: item.ticker,
      phase: item.phase,
      alphaScore: item.alphaScore,
      riskVerdict: item.riskVerdict,
      meta: { name: item.meta.name, marketCapUsd: item.meta.marketCapUsd },
      teaser: true,
      note: 'Delayed preview. Unlock /api/alpha for full ranked intel.'
    }));
  });
}
