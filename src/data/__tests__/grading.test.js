import { describe, it, expect } from 'vitest';
import { gradeSignal, deriveSlTp, signalEdge, isQualityB } from '../autoTrader.js';

// A clean, strong, migrated token that should grade A+.
// `overrides` is shallow except `flags`/`priceChange`, which are deep-merged.
function strongToken(overrides = {}) {
  const { flags = {}, priceChange = {}, ...rest } = overrides;
  return {
    ca: 'CA',
    priceUsd: 0.001,
    liquidityUsd: 50000,
    phase: 'migrated',
    lpStatus: 'Deep liquidity',
    ...rest,
    priceChange: { m5: 3, h1: 10, ...priceChange },
    flags: {
      txns5m: 40, buys5m: 30, sells5m: 8,
      reportedVolume: 5000, volumeLiquidityRatio: 2,
      freezeActive: false, mintRevoked: true,
      top10Pct: 25, madeOnSolBlacklisted: false,
      ...flags
    }
  };
}

const strongReport = { score: 85, confidence: 80, primaryRisk: null };
const cleanRug = { isRugged: false, level: 'low', isDead: false };
const strongRunner = { runnerScore: 70 };

describe('gradeSignal — safety invariants', () => {
  it('never issues BUY on a rugged/critical token', () => {
    const out = gradeSignal(strongToken(), strongReport, { isRugged: true, level: 'critical', isDead: false }, strongRunner);
    expect(out.grade).toBe('C');
    expect(out.side).toBe('SELL');
  });

  it('refuses A+/A when freeze authority is active', () => {
    const out = gradeSignal(strongToken({ flags: { freezeActive: true } }), strongReport, cleanRug, strongRunner);
    expect(['A+', 'A']).not.toContain(out.grade);
  });

  it('refuses A+/A when mint authority is still open', () => {
    const out = gradeSignal(strongToken({ flags: { mintRevoked: false } }), strongReport, cleanRug, strongRunner);
    expect(['A+', 'A']).not.toContain(out.grade);
  });

  it('drops from A+ when buy pressure collapses', () => {
    const out = gradeSignal(strongToken({ flags: { buys5m: 1, sells5m: 40 } }), strongReport, cleanRug, strongRunner);
    expect(out.grade).not.toBe('A+');
  });
});

describe('gradeSignal — positive path', () => {
  it('grades a clean strong migrated token A+', () => {
    const out = gradeSignal(strongToken(), strongReport, cleanRug, strongRunner);
    expect(out.grade).toBe('A+');
    expect(out.side).toBe('BUY');
    // v2 confidence: report.confidence*0.75 + narrativeBonus*0.6 + runner*0.12 = 60 + 0 + 8.4 ≈ 68
    expect(out.confidence).toBeGreaterThan(65);
  });

  it('downgrades A+ to A when top holders are concentrated', () => {
    const out = gradeSignal(strongToken({ flags: { top10Pct: 70 } }), strongReport, cleanRug, strongRunner);
    expect(out.grade).toBe('A');
  });
});

describe('deriveSlTp', () => {
  it('keeps a tighter stop for A+ than for B', () => {
    const aplus = deriveSlTp({ grade: 'A+', confidence: 90, token: strongToken(), runner: strongRunner });
    const b = deriveSlTp({ grade: 'B', confidence: 60, token: strongToken(), runner: { runnerScore: 20 } });
    expect(aplus.slPct).toBeLessThan(b.slPct);
  });

  it('widens the stop for thin liquidity', () => {
    const deep = deriveSlTp({ grade: 'A', confidence: 80, token: strongToken({ liquidityUsd: 60000 }), runner: strongRunner });
    const thin = deriveSlTp({ grade: 'A', confidence: 80, token: strongToken({ liquidityUsd: 10000 }), runner: strongRunner });
    expect(thin.slPct).toBeGreaterThan(deep.slPct);
  });

  it('always targets a take-profit above the stop and keeps RR in bounds', () => {
    const out = deriveSlTp({ grade: 'A', confidence: 75, token: strongToken(), runner: strongRunner });
    expect(out.tpPct).toBeGreaterThan(out.slPct);
    expect(out.rr).toBeGreaterThanOrEqual(1.4);
    expect(out.rr).toBeLessThanOrEqual(4.0);
  });
});

describe('signalEdge', () => {
  const sig = (over = {}) => ({
    score: 70, confidence: 70, m5: 2, h1: 5, alphaScore: 50,
    explain: { runnerSummary: { score: 60 }, volumeIntegrity: 70, riskNarrative: { level: 'low' } },
    ...over
  });

  it('ranks a higher-score signal above a lower-score one', () => {
    expect(signalEdge(sig({ score: 85 }))).toBeGreaterThan(signalEdge(sig({ score: 45 })));
  });

  it('penalises high rug risk', () => {
    const low = sig({ explain: { runnerSummary: { score: 60 }, volumeIntegrity: 70, riskNarrative: { level: 'low' } } });
    const high = sig({ explain: { runnerSummary: { score: 60 }, volumeIntegrity: 70, riskNarrative: { level: 'high' } } });
    expect(signalEdge(high)).toBeLessThan(signalEdge(low));
  });
});

describe('isQualityB', () => {
  const goodB = {
    confidence: 70, score: 62, m5: 1, h1: 2, liquidityUsd: 40000, buyRatio: 0.55,
    explain: { riskNarrative: { level: 'low' }, runnerSummary: { score: 50 }, volumeIntegrity: 60 }
  };

  it('accepts a clean, liquid, non-negative-momentum B', () => {
    expect(isQualityB(goodB)).toBe(true);
  });

  it('rejects a B with negative short-term momentum', () => {
    expect(isQualityB({ ...goodB, m5: -3 })).toBe(false);
  });

  it('rejects a B with thin liquidity', () => {
    expect(isQualityB({ ...goodB, liquidityUsd: 10000 })).toBe(false);
  });

  it('rejects a B with elevated rug risk', () => {
    expect(isQualityB({ ...goodB, explain: { ...goodB.explain, riskNarrative: { level: 'medium' } } })).toBe(false);
  });
});
