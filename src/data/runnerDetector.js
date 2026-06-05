import { getSnapshots, getVelocity, getFirst } from './snapshotStore';
import { getCachedBaseline, getRunnerMaxAge } from './marketRegime';

export function analyzeRunner(token, regimeBaseline = null) {
  if (!token?.ca) return emptyResult();

  const baseline = regimeBaseline || getCachedBaseline();
  const snapshots = getSnapshots(token.ca);
  const flags = token.flags || {};
  const priceChange = token.priceChange || {};
  const liquidityUsd = Number(token.liquidityUsd || 0);
  const lpStatus = String(token.lpStatus || '').toLowerCase();
  const isBondingCurve = token.provider === 'PumpPortal live websocket'
    || token.provider === 'Pump.fun frontend API'
    || lpStatus.includes('bonding');

  const txns5m = Number(flags.txns5m || 0);
  const buys5m = Number(flags.buys5m || 0);
  const sells5m = Number(flags.sells5m || 0);
  const volume5m = Number(flags.reportedVolume || 0);
  const volumeRatio = Number(flags.volumeLiquidityRatio || 0);
  const m5 = Number(priceChange.m5 || 0);
  const h1 = Number(priceChange.h1 || 0);

  // Hard exclusions — token tidak boleh jadi runner kalau kondisi ini terjadi
  // Liquidity threshold sekarang RELATIF terhadap baseline (p50 = median market)
  const minLiquidity = isBondingCurve ? 0 : baseline.liquidityUsd.p50 * 0.5; // 50% dari median
  if (isBondingCurve) {
    if (txns5m < 6) return emptyResult();
  } else if (liquidityUsd < minLiquidity) {
    return emptyResult();
  }
  if (h1 < -15) return emptyResult();
  if (m5 < -8) return emptyResult();
  if (sells5m > buys5m * 1.6) return emptyResult();

  // Volume ratio threshold juga relatif
  const maxVolRatio = baseline.volumeLiquidityRatio.p75 * 1.5; // 1.5x dari p75
  if (volumeRatio > maxVolRatio) return emptyResult();

  // Age threshold sekarang phase-aware dan lebih ketat
  const ageMinutes = token.ageMinutes
    || (token.pairCreatedAt ? Math.floor((Date.now() - token.pairCreatedAt) / 60000) : null);
  if (ageMinutes != null) {
    const maxAge = getRunnerMaxAge(token.phase);
    if (ageMinutes > maxAge) return emptyResult();
  }

  let score = 0;
  const signals = [];

  // 1. Price momentum
  if (m5 > 3) {
    score += 14;
    signals.push(`m5 +${m5.toFixed(1)}%`);
  }
  if (h1 > 8 && h1 < 500) {
    score += 14;
    signals.push(`h1 +${h1.toFixed(1)}%`);
  }

  // 2. Buy dominance
  const totalTx = buys5m + sells5m;
  const buyRatio = totalTx > 0 ? buys5m / totalTx : 0.5;
  if (buyRatio >= 0.62 && totalTx >= 15) {
    score += 16;
    signals.push(`buy ratio ${(buyRatio * 100).toFixed(0)}%`);
  } else if (buyRatio >= 0.55 && totalTx >= 25) {
    score += 8;
    signals.push(`buy ratio ${(buyRatio * 100).toFixed(0)}%`);
  }

  // 3. Real volume
  if (volume5m > liquidityUsd * 0.5 && volume5m < liquidityUsd * 4 && totalTx >= 20) {
    score += 14;
    signals.push(`vol/LP ${volumeRatio.toFixed(2)}x sehat`);
  }

  // 4. Velocity from snapshot (if available)
  const velocity = getVelocity(token.ca);
  if (velocity) {
    if (velocity.priceTrend > 0.3 && velocity.priceM5Delta > 0) {
      score += 14;
      signals.push('momentum naik konsisten');
    }
    if (velocity.volume5mTrend > 0.3 && velocity.volume5mDelta > 0) {
      score += 12;
      signals.push('volume akselerasi');
    }
    if (velocity.txnsTrend > 0.3 && velocity.txnsDelta > 0) {
      score += 8;
      signals.push('transaksi naik');
    }
    if (velocity.buyRatioTrend > 0.2) {
      score += 6;
      signals.push('buy pressure menguat');
    }
    if (velocity.liquidityRatePerMin > 0) {
      score += 4;
      signals.push('LP nambah');
    } else if (liquidityUsd > 0) {
      const drainPctPerMin = (velocity.liquidityRatePerMin / liquidityUsd) * 100;
      if (drainPctPerMin < -1.5) score -= 10;
    }
  } else {
    // No velocity history - score from current momentum only
    if (m5 > 12 && totalTx >= 30 && buyRatio >= 0.6) {
      score += 18;
      signals.push('momentum awal kuat (belum ada history)');
    } else if (m5 > 6 && totalTx >= 15 && buyRatio >= 0.55) {
      score += 10;
      signals.push('momentum awal positif');
    }
  }

  // 5. Bonus LP
  if (liquidityUsd >= 20000) score += 4;
  if (liquidityUsd >= 60000) score += 4;

  // 6. Activity
  if (txns5m >= 50) { score += 6; signals.push(`${txns5m} tx/5m`); }

  score = Math.max(0, Math.min(100, Math.round(score)));

  // isRunner requires history + high score + positive velocity
  const hasPositiveVelocity = velocity && velocity.priceTrend > 0 && velocity.priceM5Delta >= 0;
  const hasMeaningfulVolume = isBondingCurve
    ? (txns5m >= 15 && volume5m >= 800)
    : (volume5m >= 1500);
  const isRunner = score >= 72
    && signals.length >= 3
    && hasPositiveVelocity
    && hasMeaningfulVolume
    && snapshots.length >= 3;

  return {
    isRunner,
    runnerScore: score,
    signals,
    hasHistory: snapshots.length >= 3,
    ageMinutes
  };
}

function emptyResult() {
  return { isRunner: false, runnerScore: 0, signals: [], hasHistory: false, ageMinutes: null };
}
