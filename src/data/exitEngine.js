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

import { getVelocity, getLatest } from './snapshotStore';

/**
 * Hitung tier TP adaptif berdasarkan grade dan narrative.
 * Untuk memecoin, tier tidak cuma 1R-2R — tapi bisa sampai 5x-10x.
 *
 * Base tiers (multiple dari entry awal):
 * - T1: 1.2x (+20%)  — 25% posisi, SL → breakeven
 * - T2: 1.5x (+50%)  — 25% posisi
 * - T3: 2.5x (+150%) — 20% posisi
 * - T4: 4.0x (+300%) — 15% posisi
 * - Moonbag: sisa 15% — trail sampai 50x kalau narasi panas
 *
 * Narrative modifier:
 * - Hot meta + first mover: tier naik 50% (lebih tinggi, hold lebih lama)
 * - Saturated + copycat: tier turun 30% (exit lebih cepat)
 */
function getTiers(grade, entry, narrative = null, styleTpMultiplier = 1) {
  // styleTpMultiplier: <1 = realisasi lebih cepat (Agresif/Hyper), >1 = tahan lebih lama (Konservatif).
  // Diterapkan ke jarak tier dari entry (1.0 + (mult-1)*styleTpMultiplier) agar arah tetap profit.
  const styleScale = (m) => 1 + (m - 1) * (Number(styleTpMultiplier) || 1);

  const mult = (n) => {
    let base = styleScale(n);
    if (narrative?.isHotMeta && narrative?.isFirstMover) base = 1 + (base - 1) * 1.5;
    else if (narrative?.isSaturated && !narrative?.isFirstMover) base = 1 + (base - 1) * 0.7;
    return base;
  };

  // Size allocation by grade (A+ lebih agresif, B lebih defensif)
  const sizes = grade === 'A+'
    ? [0.25, 0.25, 0.20, 0.15, 0.15]
    : grade === 'A'
      ? [0.25, 0.25, 0.20, 0.15, 0.15]
      : [0.30, 0.30, 0.20, 0.10, 0.10]; // B lebih cepat exit

  return [
    { name: 'T1', multiple: mult(1.20), price: entry * mult(1.20), size: sizes[0], action: 'PARTIAL_EXIT', hit: false },
    { name: 'T2', multiple: mult(1.50), price: entry * mult(1.50), size: sizes[1], action: 'PARTIAL_EXIT', hit: false },
    { name: 'T3', multiple: mult(2.50), price: entry * mult(2.50), size: sizes[2], action: 'PARTIAL_EXIT', hit: false },
    { name: 'T4', multiple: mult(4.00), price: entry * mult(4.00), size: sizes[3], action: 'PARTIAL_EXIT', hit: false },
    { name: 'MOONBAG', multiple: null, price: null, size: sizes[4], action: 'TRAIL', hit: false }
  ];
}

/**
 * Trailing stop adaptif berdasarkan multiple dari entry.
 * Bukan fixed % — tapi makin tinggi multiple, makin longgar trail.
 *
 * Multiple < 2x   : trail 20% (protect capital)
 * Multiple 2x-5x  : trail 30% (biarkan breathe)
 * Multiple 5x-10x : trail 40% (runner mode)
 * Multiple 10x+   : trail 50% (moon mode — bisa ke 50x)
 *
 * Narrative modifier:
 * - Hot meta + first mover: trail lebih longgar (-5%)
 * - Saturated copycat: trail lebih ketat (+5%)
 */
function getTrailDrawdownPct(multiple, narrative = null) {
  let pct;
  if (multiple < 2) pct = 20;
  else if (multiple < 5) pct = 30;
  else if (multiple < 10) pct = 40;
  else pct = 50;

  if (narrative?.isHotMeta && narrative?.isFirstMover) pct -= 5;
  else if (narrative?.isSaturated && !narrative?.isFirstMover) pct += 5;

  return Math.max(15, Math.min(60, pct));
}

/**
 * Deteksi momentum death dengan nuansa narrative.
 * Untuk hot meta first-mover, lebih toleran — exit parsial 50% dulu,
 * sisanya di-trail longgar (narasi bisa recover).
 *
 * Return: { dead: boolean, gentle: boolean }
 * - dead = true, gentle = false → full exit
 * - dead = true, gentle = true → partial exit 50% sisa, sisanya trail
 */
function detectMomentumDeath(ca, currentPnlPct, narrative = null) {
  if (currentPnlPct < 10) return { dead: false, gentle: false };

  const velocity = getVelocity(ca);
  if (!velocity || velocity.snapshots < 3) return { dead: false, gentle: false };

  const priceDown = velocity.priceTrend < -0.3 && velocity.priceM5Delta < 0;
  const volumeDown = velocity.volume5mTrend < -0.2 && velocity.volume5mDelta < 0;
  const txnsDown = velocity.txnsTrend < -0.3 && velocity.txnsDelta < 0;
  const negativeCount = [priceDown, volumeDown, txnsDown].filter(Boolean).length;

  if (negativeCount < 2) return { dead: false, gentle: false };

  // Hot meta first-mover → gentle exit (parsial dulu, jangan full exit)
  if (narrative?.isHotMeta && narrative?.isFirstMover) {
    return { dead: true, gentle: true };
  }

  return { dead: true, gentle: false };
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
 * Compute exit actions untuk satu trade.
 *
 * @param {object} trade - trade object
 * @param {number} currentPrice - harga live
 * @param {object} liveToken - token snapshot (untuk velocity)
 * @param {object} currentSignal - signal terbaru setelah re-evaluate (untuk narrative)
 * @returns {object} { actions, newStop, newStatus, reason }
 */
export function computeExitActions(trade, currentPrice, liveToken, currentSignal = null) {
  if (!trade || trade.status !== 'ACTIVE') {
    return { actions: [], newStop: trade?.sl, newStatus: trade?.status, reason: null };
  }

  const { ca, entry, initialEntry, sl, grade, positionRemaining = 1.0, tiers, peakPrice = entry, slMovedToBreakeven = false } = trade;
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

  // 1. Hard SL hit — absolute stop, tidak boleh dilanggar
  if (currentPrice <= sl) {
    actions.push({ type: 'FULL_EXIT', price: currentPrice, size: positionRemaining, reason: 'SL hit' });
    newStatus = 'LOSS';
    reason = 'Stop loss tercapai';
    return { actions, newStop: sl, newStatus, reason };
  }

  // 2. Narrative cold exit — narasi sudah tidak panas lagi
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

  // 3. Momentum death exit — adaptif berdasarkan narrative
  const mom = detectMomentumDeath(ca, currentPnlPct, narrative);
  if (mom.dead) {
    if (mom.gentle && positionRemaining > 0) {
      // Gentle exit: keluarin 50% sisa, sisanya trail
      const exitSize = positionRemaining * 0.5;
      actions.push({ type: 'PARTIAL_EXIT', tier: 'MOMENTUM_HALF', price: currentPrice, size: exitSize, reason: 'Momentum mati — exit 50% sisa (first-mover mode)' });

      // Move trailing stop ke entry (breakeven) untuk sisa
      if (!slMovedToBreakeven) {
        actions.push({ type: 'MOVE_STOP', newStop: entry, reason: 'SL ke breakeven setelah momentum death gentle' });
      }

      return { actions, newStop: entry, newStatus: 'ACTIVE', reason: 'Momentum melemah — exit parsial, sisanya di-trail' };
    } else {
      // Full exit
      actions.push({ type: 'FULL_EXIT', price: currentPrice, size: positionRemaining, reason: 'Momentum mati' });
      newStatus = currentPnlPct > 0 ? 'WIN' : 'LOSS';
      reason = 'Momentum mati — velocity berbalik negatif';
      return { actions, newStop: sl, newStatus, reason };
    }
  }

  // 4. Partial exits di tier bertingkat (multiple-based).
  // Tier di-clone agar tidak memutasi objek trade lama; hasilnya dipersist via nextTiers.
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
        newStop = entry;
        actions.push({ type: 'MOVE_STOP', newStop: entry, reason: 'SL ke breakeven setelah T1' });
      }
    }
  }
  const activeTiers = nextTiers;

  // 5. Trailing stop untuk moonbag (setelah semua tier partial hit)
  const allPartialsHit = activeTiers.filter(t => t.action === 'PARTIAL_EXIT').every(t => t.hit);
  if (allPartialsHit && positionRemaining > 0) {
    const peak = Math.max(peakPrice, currentPrice);
    const trailPct = getTrailDrawdownPct(multiple, narrative);
    const trailStop = peak * (1 - trailPct / 100);

    if (trailStop > newStop) {
      newStop = trailStop;
      actions.push({ type: 'TRAIL_STOP', newStop: trailStop, peak, trailPct, reason: `Trail ${trailPct}% @ ${multiple.toFixed(1)}x peak` });
    }

    if (currentPrice <= trailStop) {
      actions.push({ type: 'FULL_EXIT', price: currentPrice, size: positionRemaining, reason: 'Trailing stop hit' });
      newStatus = 'WIN';
      reason = `Trailing stop @ ${multiple.toFixed(1)}x — exit ${currentPnlPct.toFixed(1)}%`;
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
