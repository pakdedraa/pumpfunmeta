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

  // ── Hard exclusions v2 — lebih selektif tapi tidak over-filter ──
  const minLiquidity = isBondingCurve ? 0 : baseline.liquidityUsd.p50 * 0.4; // ↓ dari 0.5
  if (isBondingCurve) {
    if (txns5m < 5) return emptyResult();        // ↓ dari 6
  } else if (liquidityUsd < minLiquidity) {
    return emptyResult();
  }
  if (h1 < -12) return emptyResult();             // ↓ dari -10 → toleransi dikit
  if (m5 < -6) return emptyResult();              // ↓ dari -5
  if (sells5m > buys5m * 1.8) return emptyResult(); // ↑ dari 1.6 → lebih longgar

  // Volume ratio threshold relatif
  const maxVolRatio = baseline.volumeLiquidityRatio.p75 * 2.0; // ↑ dari 1.5 → lebih longgar
  if (volumeRatio > maxVolRatio) return emptyResult();

  // Age threshold phase-aware
  const ageMinutes = token.ageMinutes
    || (token.pairCreatedAt ? Math.floor((Date.now() - token.pairCreatedAt) / 60000) : null);
  if (ageMinutes != null) {
    const maxAge = getRunnerMaxAge(token.phase);
    if (ageMinutes > maxAge) return emptyResult();
  }

  let score = 0;
  const signals = [];

  // 1. Price momentum — tiered scoring
  if (m5 > 8) {
    score += 18;                                  // ↑ dari 14
    signals.push(`m5 +${m5.toFixed(1)}%`);
  } else if (m5 > 3) {
    score += 14;
    signals.push(`m5 +${m5.toFixed(1)}%`);
  }
  if (h1 > 15 && h1 < 500) {
    score += 18;                                  // ↑ dari 14
    signals.push(`h1 +${h1.toFixed(1)}%`);
  } else if (h1 > 8 && h1 < 500) {
    score += 14;
    signals.push(`h1 +${h1.toFixed(1)}%`);
  }

  // 2. Buy dominance — tiered dengan volume minimum
  const totalTx = buys5m + sells5m;
  const buyRatio = totalTx > 0 ? buys5m / totalTx : 0.5;
  if (buyRatio >= 0.65 && totalTx >= 20) {
    score += 18;                                  // ↑ dari 16
    signals.push(`buy ratio ${(buyRatio * 100).toFixed(0)}% kuat`);
  } else if (buyRatio >= 0.58 && totalTx >= 15) { // ↑ dari 0.55
    score += 10;                                  // ↑ dari 8
    signals.push(`buy ratio ${(buyRatio * 100).toFixed(0)}%`);
  } else if (buyRatio >= 0.52 && totalTx >= 25) {
    score += 5;
    signals.push(`buy ratio cukup`);
  }

  // 3. Real volume — cek volume vs liquidity
  if (volume5m > liquidityUsd * 0.4 && volume5m < liquidityUsd * 4 && totalTx >= 15) { // ↓ dari 0.5 & 20
    score += 14;
    signals.push(`vol/LP ${volumeRatio.toFixed(2)}x sehat`);
  }

  // 4. Velocity from snapshot (if available)
  const velocity = getVelocity(token.ca);
  if (velocity) {
    if (velocity.priceTrend > 0.25 && velocity.priceM5Delta > 0) {  // ↓ dari 0.3
      score += 14;
      signals.push('momentum naik konsisten');
    }
    if (velocity.volume5mTrend > 0.25 && velocity.volume5mDelta > 0) { // ↓ dari 0.3
      score += 12;
      signals.push('volume akselerasi');
    }
    if (velocity.txnsTrend > 0.25 && velocity.txnsDelta > 0) {  // ↓ dari 0.3
      score += 8;
      signals.push('transaksi naik');
    }
    if (velocity.buyRatioTrend > 0.15) {  // ↓ dari 0.2 — lebih sensitif untuk tangkap awal
      score += 8;                         // ↑ dari 6
      signals.push('buy pressure menguat');
    }
    if (velocity.liquidityRatePerMin > 0) {
      score += 4;
      signals.push('LP nambah');
    } else if (liquidityUsd > 0) {
      const drainPctPerMin = (velocity.liquidityRatePerMin / liquidityUsd) * 100;
      if (drainPctPerMin < -1.5) score -= 10;
    }

    // BARU: Volume acceleration check (apakah volume masih naik atau mulai plateau)
    if (velocity.volume5mTrend > 0.4 && velocity.volume5mDelta > 0) {
      score += 4;
      signals.push('volume akselerasi kuat');
    } else if (velocity.volume5mTrend < -0.3 && velocity.snapshots >= 4) {
      score -= 8;
      signals.push('volume mulai turun');
    }
  } else {
    // No velocity history - score from current momentum only
    if (m5 > 15 && totalTx >= 40 && buyRatio >= 0.62) {
      score += 20;                                // ↑ dari 18
      signals.push('momentum awal sangat kuat');
    } else if (m5 > 10 && totalTx >= 25 && buyRatio >= 0.55) {
      score += 14;                                // ↑ dari 10
      signals.push('momentum awal kuat');
    } else if (m5 > 5 && totalTx >= 12 && buyRatio >= 0.52) {
      score += 8;
      signals.push('momentum awal positif');
    }
  }

  // 5. Bonus LP — tiered
  if (liquidityUsd >= 80000) score += 8;          // BARU: tier tambahan
  else if (liquidityUsd >= 40000) score += 5;     // ↑ dari 20000
  else if (liquidityUsd >= 15000) score += 3;

  // 6. Activity — tiered
  if (txns5m >= 80) { score += 8; signals.push(`${txns5m} tx/5m tinggi`); }
  else if (txns5m >= 40) { score += 5; signals.push(`${txns5m} tx/5m`); }

  score = Math.max(0, Math.min(100, Math.round(score)));

  // ── isRunner v2 — lebih inklusif dengan konfirmasi volume ──
  // Threshold skor diturunkan 72→64 untuk tangkap lebih banyak runner valid
  const hasPositiveVelocity = velocity
    ? (velocity.priceTrend > 0 && velocity.priceM5Delta >= 0)
    : (m5 > 3 && buyRatio >= 0.55);  // fallback kalau belum ada history
  const hasMeaningfulVolume = isBondingCurve
    ? (txns5m >= 12 && volume5m >= 600)  // ↓ dari 15/800
    : (volume5m >= 1200);                // ↓ dari 1500
  const hasBuyPressure = buyRatio >= 0.52;
  const isRunner = score >= 64           // ↓ dari 72
    && signals.length >= 3
    && hasPositiveVelocity
    && hasMeaningfulVolume
    && hasBuyPressure
    && snapshots.length >= 2;            // ↓ dari 3 — bisa deteksi lebih awal

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
