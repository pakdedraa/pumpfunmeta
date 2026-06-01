import { describe, it, expect } from 'vitest';
import { scoreToken, riskVerdict, phaseFor } from '../alpha.js';

function coin(overrides = {}) {
  return {
    bondingCurveProgress: 50,
    ageSeconds: 600,
    usdMarketCap: 30000,
    replies: 0,
    ...overrides
  };
}

describe('scoreToken', () => {
  it('clamps the score to 0..100', () => {
    const hot = scoreToken(coin({ bondingCurveProgress: 60, ageSeconds: 300, usdMarketCap: 40000, replies: 200, twitter: 'x' }));
    expect(hot).toBeGreaterThanOrEqual(0);
    expect(hot).toBeLessThanOrEqual(100);
  });

  it('prefers a token in the bonding sweet spot over a topped-out one', () => {
    const sweet = scoreToken(coin({ bondingCurveProgress: 55 }));
    const topped = scoreToken(coin({ bondingCurveProgress: 98 }));
    expect(sweet).toBeGreaterThan(topped);
  });

  it('prefers a fresh token over a day-old one', () => {
    const fresh = scoreToken(coin({ ageSeconds: 600 }));
    const old = scoreToken(coin({ ageSeconds: 90000 }));
    expect(fresh).toBeGreaterThan(old);
  });

  it('rewards social engagement and links', () => {
    const bare = scoreToken(coin({ replies: 0 }));
    const social = scoreToken(coin({ replies: 60, twitter: 'https://x.com/a' }));
    expect(social).toBeGreaterThan(bare);
  });
});

describe('riskVerdict', () => {
  it('marks extreme top-10 concentration as high-risk regardless of score', () => {
    expect(riskVerdict(90, { top10Pct: 80 })).toBe('high-risk');
  });

  it('marks many common funders as high-risk', () => {
    expect(riskVerdict(90, { commonFunderWallets: 6 })).toBe('high-risk');
  });

  it('escalates verdict with score when intel is clean', () => {
    expect(riskVerdict(75, null)).toBe('watch');
    expect(riskVerdict(55, null)).toBe('neutral');
    expect(riskVerdict(20, null)).toBe('low-conviction');
  });
});

describe('phaseFor', () => {
  it('reports migrated for a completed curve', () => {
    expect(phaseFor({ completed: true })).toBe('migrated');
  });

  it('reports soon past 60% bonding and new below it', () => {
    expect(phaseFor({ bondingCurveProgress: 70 })).toBe('soon');
    expect(phaseFor({ bondingCurveProgress: 20 })).toBe('new');
  });
});
