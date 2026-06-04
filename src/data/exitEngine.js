/**
 * exitEngine.js — Adaptive Multi-X Exit Engine
 *
 * Tidak lagi pakai SL/TP statis. Sistem ini:
 * 1. Entry bertahap (DCA) dengan sizing adaptif
 * 2. Partial TP bertingkat yang scale dengan multiple (bukan % fixed)
 * 3. Trailing stop adaptif — makin tinggi multiple, makin longgar trail-nya
 * 4. Narrative-aware exit — hot meta + first mover = hold lebih lama
 * 5. Momentum-death exit yang gentle untuk runner (exit parsial dulu)
 *
 * Target: capture 5x, 10x, 50x runner tanpa ke-stop prematur.
 */

import { getVelocity } from './snapshotStore';

/**
 * Hitung tier TP adaptif berdasarkan grade dan narrative. v2 — PROFESSIONAL CALIBRATION
 *
 * Filosofi baru: realisasi profit CEPAT di awal, biarkan moonbag lari.
 * Tier T1 lebih rendah (1.10x) untuk mulai keluar di profit kecil.
 * Alokasi size: lebih banyak di-realisi di T1-T2 untuk naikkan winrate.
 *
 * Narrative modifier:
 * - Hot meta + first mover: tier naik 40% (bukan 50%) — tetap kasih ruang
 * - Saturated + copycat: tier turun 35% (bukan 30%) — exit lebih cepat
 */
function getTiers(grade, entry, narrative = null, styleTpMultiplier = 1) {
  // styleTpMultiplier: <1 = realisasi lebih cepat (Agresif/Hyper), >1 = tahan lebih lama (Konservatif).
  const styleScale = (m) => 1 + (m - 1) * (Number(styleTpMultiplier) || 1);

  const mult = (n) => {
    let base = styleScale(n);
    if (narrative?.isHotMeta && narrative?.isFirstMover) base = 1 + (base - 1) * 1.4;
    else if (narrative?.isSaturated && !narrative?.isFirstMover) base = 1 + (base - 1) * 0.65;
    return base;
  };

  // Size allocation v2: lebih banyak di awal untuk naikkan winrate
  // A+:  30% di T1 (1.08x), 25% di T2, 20% T3, 15% T4, 10% moonbag
  // A:   35% di T1, 25% di T2, 20% T3, 10% T4, 10% moonbag
  // B:   40% di T1, 30% di T2, 15% T3, 10% T4, 5% moonbag
  const sizes = grade === 'A+'
    ? [0.30, 0.25, 0.20, 0.15, 0.10]
    : grade === 'A'
      ? [0.35, 0.25, 0.20, 0.10, 0.10]
      : [0.40, 0.30, 0.15, 0.10, 0.05]; // B lebih defensif — exit lebih banyak di awal

  return [
    { name: 'T1', multiple: mult(1.08), price: entry * mult(1.08), size: sizes[0], action: 'PARTIAL_EXIT', hit: false },
    { name: 'T2', multiple: mult(1.30), price: entry * mult(1.30), size: sizes[1], action: 'PARTIAL_EXIT', hit: false },
    { name: 'T3', multiple: mult(2.00), price: entry * mult(2.00), size: sizes[2], action: 'PARTIAL_EXIT', hit: false },
    { name: 'T4', multiple: mult(3.50), price: entry * mult(3.50), size: sizes[3], action: 'PARTIAL_EXIT', hit: false },
    { name: 'MOONBAG', multiple: null, price: null, size: sizes[4], action: 'TRAIL', hit: false }
  ];
}

/**
 * Trailing stop adaptif v2 — LEBIH KETAT untuk memecoin.
 *
 * Memecoin bisa dump 50%+ dalam hitungan menit. Trail harus lebih ketat
 * untuk mengamankan profit, terutama di multiple rendah.
 *
 * Multiple < 2x   : trail 12% (bukan 20%) — protect capital aggressively
 * Multiple 2x-5x  : trail 20% (bukan 30%) — biarkan breathe secukupnya
 * Multiple 5x-10x : trail 30% (bukan 40%) — runner mode
 * Multiple 10x+   : trail 40% (bukan 50%) — moon mode, tetap amankan gains
 *
 * Narrative modifier:
 * - Hot meta + first mover: trail lebih longgar (-3%, bukan -5%)
 * - Saturated copycat: trail lebih ketat (+7%, bukan +5%)
 */
function getTrailDrawdownPct(multiple, narrative = null) {
  let pct;
  if (multiple < 2) pct = 12;
  else if (multiple < 5) pct = 20;
  else if (multiple < 10) pct = 30;
  else pct = 40;

  if (narrative?.isHotMeta && narrative?.isFirstMover) pct -= 3;
  else if (narrative?.isSaturated && !narrative?.isFirstMover) pct += 7;

  return Math.max(10, Math.min(50, pct));
}

/**
 * Deteksi momentum death v2 — MULTI-DIMENSIONAL.
 *
 * Cek sekarang meliputi:
 * 1. Price velocity turun + price delta negatif
 * 2. Volume menurun + volume delta negatif
 * 3. Transaksi menurun
 * 4. Buy pressure drop (BARU) — paling penting: kalau buyer kabur, momentum mati
 * 5. Price deceleration (BARU) — M5 mulai melambat dibanding peak
 *
 * Threshold disesuaikan: sekarang deteksi lebih awal (tidak tunggu parah dulu).
 *
 * Return: { dead: boolean, gentle: boolean, signals: string[] }
 */
function detectMomentumDeath(ca, currentPnlPct, narrative = null) {
  if (currentPnlPct < 5) return { dead: false, gentle: false, signals: [] };

  const velocity = getVelocity(ca);
  if (!velocity || velocity.snapshots < 2) return { dead: false, gentle: false, signals: [] };

  const signals = [];

  // 1. Price velocity — lebih sensitif
  const priceDown = velocity.priceTrend <= -0.2 && velocity.priceM5Delta < 0;
  if (priceDown) signals.push('price velocity turun');

  // 2. Volume menurun
  const volumeDown = velocity.volume5mTrend <= -0.15 && velocity.volume5mDelta < 0;
  if (volumeDown) signals.push('volume menurun');

  // 3. Transaksi menurun
  const txnsDown = velocity.txnsTrend <= -0.2 && velocity.txnsDelta < 0;
  if (txnsDown) signals.push('transaksi menurun');

  // 4. Buy pressure drop (BARU — sinyal paling penting)
  const buyRatioDropping = velocity.buyRatioTrend <= -0.25;
  const buyRatioLow = velocity.buyRatio < 0.45;
  const buyPressureDead = buyRatioDropping || (buyRatioLow && velocity.snapshots >= 3);
  if (buyPressureDead) signals.push('buy pressure menghilang');

  // 5. Price deceleration (BARU) — M5 melambat
  const priceDecelerating = velocity.priceM5Delta < -1.5 && velocity.priceTrend <= 0;
  if (priceDecelerating) signals.push('harga mulai melambat');

  // Combine semua sinyal
  const negativeCount = signals.length;

  // Butuh minimal 2 sinyal negatif dengan snapshots >= 3
  if (negativeCount < 2 && velocity.snapshots < 3) return { dead: false, gentle: false, signals };

  // Kalau buy pressure mati + satu sinyal lain → momentum death confirmed
  if (buyPressureDead && negativeCount >= 2) {
    if (narrative?.isHotMeta && narrative?.isFirstMover && currentPnlPct > 30) {
      return { dead: true, gentle: true, signals };
    }
    return { dead: true, gentle: false, signals };
  }

  // Kalau 3+ sinyal negatif → momentum death
  if (negativeCount >= 3) {
    if (narrative?.isHotMeta && narrative?.isFirstMover) {
      return { dead: true, gentle: true, signals };
    }
    return { dead: true, gentle: false, signals };
  }

  // Kalau cuma 2 sinyal tanpa buy pressure mati → warning, belum death
  if (negativeCount >= 2 && currentPnlPct > 40) {
    // Profit sudah besar + sinyal melemah → gentle exit
    return { dead: true, gentle: true, signals };
  }

  return { dead: false, gentle: false, signals };
}

/**
 * Narrative death exit: kalau narasi sudah dingin (sudah tidak hot meta lagi)
 * tapi posisi masih profit, exit pelan-pelan.
 * Ini di-handle di luar (by comparing signal re-evaluation), tapi kita
 * beri signal di sini untuk diperiksa caller.
 */
function isNarrativeCold(signalNarrative, currentNarrative) {
  if (!signalNarrative || !currentNarrative) return false;
  // Kalau dulu hot meta + first mover, sekarang bukan lagi
  if (signalNarrative.isHotMeta && signalNarrative.isFirstMover) {
    if (!currentNarrative.isHotMeta || !currentNarrative.isFirstMover) {
      return true;
    }
  }
  return false;
}

/**
 * Compute exit actions untuk satu trade. v2 — MULTI-LAYER EXIT
 *
 * Layer exit (dicek berurutan):
 * 1. Hard SL hit — tidak bisa dinego
 * 2. Time-based exit — posisi terlalu lama tanpa profit → cut
 * 3. Profit protection — SL ke breakeven setelah profit >8%
 * 4. Narrative cold exit — narasi sudah tidak panas
 * 5. Momentum death exit — velocity berbalik (adaptif narrative)
 * 6. Tiered partial TP — realisasi profit bertahap
 * 7. Trailing stop untuk moonbag
 *
 * @param {object} trade - trade object
 * @param {number} currentPrice - harga live
 * @param {object} liveToken - token snapshot (untuk velocity)
 * @param {object} currentSignal - signal terbaru setelah re-evaluate (untuk narrative)
 * @returns {object} { actions, newStop, newStatus, reason, tiers }
 */
export function computeExitActions(trade, currentPrice, liveToken, currentSignal = null) {
  if (!trade || trade.status !== 'ACTIVE') {
    return { actions: [], newStop: trade?.sl, newStatus: trade?.status, reason: null };
  }

  const { ca, entry, initialEntry, sl, grade, positionRemaining = 1.0, tiers, peakPrice = entry, slMovedToBreakeven = false, openedAt } = trade;
  const tierBase = initialEntry || entry;
  const narrative = trade.signal?.narrative || null;

  if (!entry || !currentPrice || currentPrice <= 0) {
    return { actions: [], newStop: sl, newStatus: 'ACTIVE', reason: null };
  }

  const currentPnlPct = ((currentPrice - entry) / entry) * 100;
  const multiple = currentPrice / tierBase;
  const actions = [];
  let newStop = sl;
  let newStatus = 'ACTIVE';
  let reason = null;

  // ── 1. Hard SL hit — absolute stop, tidak boleh dilanggar ──
  if (currentPrice <= sl) {
    actions.push({ type: 'FULL_EXIT', price: currentPrice, size: positionRemaining, reason: 'SL hit' });
    newStatus = 'LOSS';
    reason = 'Stop loss tercapai';
    return { actions, newStop: sl, newStatus, reason };
  }

  // ── 1b. Time-based exit: posisi stagnan terlalu lama ──
  // Kalau posisi sudah buka >90 menit tapi profit <5% → exit (momentum probably dead)
  if (openedAt && positionRemaining > 0) {
    const holdMinutes = (Date.now() - openedAt) / 60000;
    const isStagnant = currentPnlPct < 5 && currentPnlPct > -3 && holdMinutes > 90;
    const isOldAndLosing = currentPnlPct < -2 && holdMinutes > 60;
    if (isStagnant || isOldAndLosing) {
      actions.push({ type: 'FULL_EXIT', price: currentPrice, size: positionRemaining, reason: 'Posisi stagnan terlalu lama' });
      newStatus = currentPnlPct > 0 ? 'WIN' : 'LOSS';
      reason = isStagnant
        ? `Stagnan ${holdMinutes.toFixed(0)} menit tanpa profit signifikan — exit`
        : `Posisi rugi ${holdMinutes.toFixed(0)} menit — cut loss`;
      return { actions, newStop: sl, newStatus, reason };
    }
  }

  // ── 2. Profit protection: SL ke breakeven lebih awal ──
  // Setelah profit >6% (bukan tunggu T1), SL langsung ke entry + buffer 1%
  if (!slMovedToBreakeven && currentPnlPct >= 6 && positionRemaining > 0) {
    const breakevenStop = entry * 1.01; // entry + 1% buffer (biar nggak kena noise)
    if (breakevenStop > sl) {
      newStop = breakevenStop;
      actions.push({ type: 'MOVE_STOP', newStop: breakevenStop, reason: 'SL ke breakeven +1% setelah profit >6%' });
    }
  }

  // ── 3. Narrative cold exit — narasi sudah tidak panas lagi ──
  if (currentSignal && isNarrativeCold(narrative, currentSignal.narrative)) {
    if (currentPnlPct > 0) {
      actions.push({ type: 'FULL_EXIT', price: currentPrice, size: positionRemaining, reason: 'Narrative sudah dingin' });
      newStatus = 'WIN';
      reason = 'Narasi tidak lagi panas — exit sisa posisi';
    } else {
      actions.push({ type: 'FULL_EXIT', price: currentPrice, size: positionRemaining, reason: 'Narrative sudah dingin (loss)' });
      newStatus = 'LOSS';
      reason = 'Narasi dingin — cut loss';
    }
    return { actions, newStop: sl, newStatus, reason };
  }

  // ── 3b. Rapid dump detection — dump >12% dalam 5 menit = exit instan ──
  // Ini adalah mekanisme pertahanan terhadap rug pull / whale dump mendadak
  if (currentPnlPct > 15 && positionRemaining > 0) {
    const velocity = getVelocity(ca);
    if (velocity && velocity.snapshots >= 2) {
      const rapidDump = velocity.priceM5Delta < -8 && velocity.priceTrend < -0.4;
      // Volume spike tidak normal: delta > 3000 atau vol/LP ratio spike
      const volumeAbnormal = velocity.volume5mDelta > 3000 && velocity.volume5mTrend < -0.2;
      if (rapidDump && volumeAbnormal) {
        // Dump cepat + volume besar = exit liquidity event. Keluar sekarang.
        actions.push({ type: 'FULL_EXIT', price: currentPrice, size: positionRemaining, reason: 'Rapid dump + volume spike — kemungkinan exit liquidity' });
        newStatus = 'WIN';  // masih profit
        reason = `Dump cepat ${Math.abs(velocity.priceM5Delta).toFixed(1)}% dalam 5m — amankan profit +${currentPnlPct.toFixed(1)}%`;
        return { actions, newStop: sl, newStatus, reason };
      }
      // Dump cepat saja tanpa volume explosion → exit parsial 50%
      if (rapidDump && currentPnlPct > 30) {
        const exitSize = positionRemaining * 0.5;
        actions.push({ type: 'PARTIAL_EXIT', tier: 'DUMP_PROTECT', price: currentPrice, size: exitSize, reason: `Dump cepat ${Math.abs(velocity.priceM5Delta).toFixed(1)}% — amankan 50% sisa` });
        // Update newStop ke entry untuk sisa
        if (!slMovedToBreakeven) {
          newStop = entry * 1.01;
          actions.push({ type: 'MOVE_STOP', newStop: entry * 1.01, reason: 'SL ke breakeven setelah dump protection' });
        }
        return { actions, newStop: entry * 1.01, newStatus: 'ACTIVE', reason: `Dump cepat — exit 50%, sisanya di-breakeven` };
      }
    }
  }

  // ── 4. Momentum death exit — multi-dimensional ──
  const mom = detectMomentumDeath(ca, currentPnlPct, narrative);
  if (mom.dead) {
    if (mom.gentle && positionRemaining > 0) {
      // Gentle exit: keluarin 60% sisa (↑ dari 50%), sisanya trail
      const exitSize = positionRemaining * 0.6;
      actions.push({ type: 'PARTIAL_EXIT', tier: 'MOMENTUM_HALF', price: currentPrice, size: exitSize, reason: `Momentum melemah: ${mom.signals.join(', ')}` });

      // SL ke breakeven untuk sisa
      if (!slMovedToBreakeven) {
        const beStop = entry * 1.01;
        actions.push({ type: 'MOVE_STOP', newStop: beStop, reason: 'SL ke breakeven setelah momentum death gentle' });
      }

      return { actions, newStop: entry * 1.01, newStatus: 'ACTIVE', reason: `Momentum melemah — exit 60% sisa (${mom.signals[0]})` };
    } else {
      // Full exit
      actions.push({ type: 'FULL_EXIT', price: currentPrice, size: positionRemaining, reason: `Momentum mati: ${mom.signals.join(', ')}` });
      newStatus = currentPnlPct > 0 ? 'WIN' : 'LOSS';
      reason = `Momentum mati — ${mom.signals[0]}`;
      return { actions, newStop: sl, newStatus, reason };
    }
  }

  // ── 5. Partial exits di tier bertingkat (multiple-based) ──
  const styleTpMultiplier = trade.signal?.styleTpMultiplier ?? trade.styleTpMultiplier ?? 1;
  const sourceTiers = tiers && tiers.length ? tiers : getTiers(grade, tierBase, narrative, styleTpMultiplier);
  const nextTiers = sourceTiers.map((t) => ({ ...t }));

  for (const tier of nextTiers) {
    if (tier.action !== 'PARTIAL_EXIT') continue;
    if (tier.hit) continue;

    if (currentPrice >= tier.price) {
      actions.push({ type: 'PARTIAL_EXIT', tier: tier.name, price: tier.price, size: tier.size, reason: `${tier.name} tercapai ${tier.multiple?.toFixed(1)}x` });
      tier.hit = true;

      // Breakeven setelah T1
      if (tier.name === 'T1' && !slMovedToBreakeven) {
        newStop = entry * 1.01;
        actions.push({ type: 'MOVE_STOP', newStop: entry * 1.01, reason: 'SL ke breakeven setelah T1' });
      }
    }
  }
  const activeTiers = nextTiers;

  // ── 6. Trailing stop untuk moonbag (setelah semua tier partial hit) ──
  const allPartialsHit = activeTiers.filter(t => t.action === 'PARTIAL_EXIT').every(t => t.hit);
  if (allPartialsHit && positionRemaining > 0) {
    const peak = Math.max(peakPrice, currentPrice);
    const trailPct = getTrailDrawdownPct(multiple, narrative);
    const trailStop = peak * (1 - trailPct / 100);

    if (trailStop > newStop) {
      newStop = trailStop;
      actions.push({ type: 'TRAIL_STOP', newStop: trailStop, peak, trailPct, reason: `Trail ${trailPct}% @ ${multiple.toFixed(1)}x` });
    }

    if (currentPrice <= trailStop) {
      actions.push({ type: 'FULL_EXIT', price: currentPrice, size: positionRemaining, reason: 'Trailing stop hit' });
      newStatus = 'WIN';
      reason = `Trailing stop @ ${multiple.toFixed(1)}x — exit +${currentPnlPct.toFixed(1)}%`;
      return { actions, newStop: trailStop, newStatus, reason, tiers: activeTiers };
    }
  }

  return { actions, newStop, newStatus, reason, tiers: activeTiers };
}

/**
 * Apply exit actions ke trade object (pure function).
 */
export function applyExitActions(trade, actions, currentPrice) {
  let newTrade = { ...trade };
  let realizedPnl = trade.realizedPnl || 0;
  let positionRemaining = trade.positionRemaining ?? 1.0;
  const exitEvents = [...(trade.exitEvents || [])];

  for (const action of actions) {
    const timestamp = Date.now();

    if (action.type === 'PARTIAL_EXIT') {
      const exitSize = action.size;
      const exitPrice = action.price;
      const exitPnlPct = ((exitPrice - trade.entry) / trade.entry) * 100;
      const weightedPnl = exitPnlPct * exitSize;

      realizedPnl += weightedPnl;
      positionRemaining -= exitSize;

      exitEvents.push({
        type: 'PARTIAL_EXIT',
        tier: action.tier,
        price: exitPrice,
        size: exitSize,
        pnlPct: exitPnlPct,
        reason: action.reason,
        timestamp
      });
    } else if (action.type === 'FULL_EXIT') {
      const exitPrice = action.price;
      const exitPnlPct = ((exitPrice - trade.entry) / trade.entry) * 100;
      const weightedPnl = exitPnlPct * positionRemaining;

      realizedPnl += weightedPnl;

      exitEvents.push({
        type: 'FULL_EXIT',
        price: exitPrice,
        size: positionRemaining,
        pnlPct: exitPnlPct,
        reason: action.reason,
        timestamp
      });

      positionRemaining = 0;
      newTrade.closePrice = exitPrice;
      newTrade.closedAt = timestamp;
    } else if (action.type === 'MOVE_STOP') {
      newTrade.sl = action.newStop;
      newTrade.slMovedToBreakeven = true;
      exitEvents.push({
        type: 'MOVE_STOP',
        newStop: action.newStop,
        reason: action.reason,
        timestamp
      });
    } else if (action.type === 'TRAIL_STOP') {
      newTrade.sl = action.newStop;
      newTrade.peakPrice = action.peak;
      exitEvents.push({
        type: 'TRAIL_STOP',
        newStop: action.newStop,
        peak: action.peak,
        trailPct: action.trailPct,
        reason: action.reason,
        timestamp
      });
    }
  }

  const unrealizedPnl = positionRemaining > 0 && currentPrice
    ? ((currentPrice - trade.entry) / trade.entry) * 100 * positionRemaining
    : 0;

  newTrade.realizedPnl = realizedPnl;
  newTrade.positionRemaining = positionRemaining;
  newTrade.pnlPct = realizedPnl + unrealizedPnl;
  newTrade.exitEvents = exitEvents;

  return newTrade;
}
