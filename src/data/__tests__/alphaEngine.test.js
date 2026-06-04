import { describe, it, expect } from 'vitest';
import { computeAlpha, classifyPhase, alphaTier } from '../alphaEngine.js';

// Minimal feed-token factory — only the fields the alpha engine reads.
function token(overrides = {}) {
  return {
    ca: 'So11111111111111111111111111111111111111112',
    ticker: 'TEST',
    phase: 'migrated',
    lpStatus: 'Deep liquidity',
    pairDex: 'raydium',
    priceChange: { m5: 0, h1: 0 },
    flags: {},
    ...overrides
  };
}

describe('classifyPhase', () => {
  it('flags a near-full bonding curve as graduating', () => {
    const p = classifyPhase(token({ phase: 'new', lpStatus: 'Bonding curve', flags: { bondingCurveProgress: 88 } }));
    expect(p.key).toBe('graduating');
    expect(p.bondingProgress).toBe(88);
  });

  it('treats a fresh low-progress bonding token as new', () => {
    const p = classifyPhase(token({ phase: 'new', lpStatus: 'Bonding curve', flags: { bondingCurveProgress: 12 } }));
    expect(p.key).toBe('new');
  });

  it('treats a Raydium-listed token as migrated', () => {
    const p = classifyPhase(token({ phase: 'migrated', pairDex: 'raydium', lpStatus: 'Deep liquidity' }));
    expect(p.key).toBe('migrated');
    expect(p.bondingProgress).toBe(100);
  });
});

describe('computeAlpha', () => {
  it('always returns an integer alphaScore within 0..100', () => {
    const out = computeAlpha(token());
    expect(out.alphaScore).toBeGreaterThanOrEqual(0);
    expect(out.alphaScore).toBeLessThanOrEqual(100);
    expect(Number.isInteger(out.alphaScore)).toBe(true);
  });

  it('rewards KOL presence with a smart-money reason and higher score', () => {
    const base = computeAlpha(token());
    const withKol = computeAlpha(token({ flags: { kolDetected: true, smartMoneyCount: 2 } }));
    expect(withKol.alphaScore).toBeGreaterThan(base.alphaScore);
    expect(withKol.reasons.join(' ')).toMatch(/KOL/i);
  });

  it('gives a graduating token the pre-migration phase bonus', () => {
    const grad = computeAlpha(token({ phase: 'new', lpStatus: 'Bonding curve', flags: { bondingCurveProgress: 90 } }));
    expect(grad.components.phase).toBe(12);
    expect(grad.phase.key).toBe('graduating');
  });

  it('penalises extreme holder concentration', () => {
    const clean = computeAlpha(token({ flags: { top10Pct: 25 } }));
    const concentrated = computeAlpha(token({ flags: { top10Pct: 75 } }));
    expect(concentrated.components.holder).toBeLessThan(clean.components.holder);
  });

  it('uses runner momentum when supplied', () => {
    const out = computeAlpha(token(), { runner: { runnerScore: 80 } });
    expect(out.components.momentum).toBeGreaterThan(0);
    expect(out.reasons.join(' ')).toMatch(/momentum/i);
  });

  it('caps the reasons list at 5 entries', () => {
    const out = computeAlpha(
      token({ flags: { kolDetected: true, smartMoneyCount: 3, top10Pct: 20, bondingCurveProgress: 90, buys5m: 30, sells5m: 1 } }),
      { runner: { runnerScore: 90 }, narrative: { isFirstMover: true, narrativeScore: 8, themes: ['ai'] } }
    );
    expect(out.reasons.length).toBeLessThanOrEqual(5);
  });
});

describe('alphaTier', () => {
  it('maps scores to ascending tiers', () => {
    expect(alphaTier(80).label).toMatch(/Tinggi/);
    expect(alphaTier(60).label).toMatch(/Menengah/);
    expect(alphaTier(40).label).toMatch(/Rendah/);
    expect(alphaTier(10).label).toMatch(/Minim/);
  });
});
