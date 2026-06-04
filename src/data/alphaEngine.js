/**
 * alphaEngine.js — Lapisan deteksi ALPHA / META di atas analisa risiko.
 *
 * Menjawab kebutuhan: bukan cuma sinyal risk, tapi juga "alpha" — fase token
 * (new / graduating-soon / migrated), tema/meta yang sedang jalan, dan skor
 * alpha komposit (smart-money/KOL, momentum, narasi, kesehatan holder, bonding
 * progress). Deterministik & murah (tanpa AI di sini); label AI opsional bisa
 * disuntik lewat narrative.externalThemeLabel dari backend.
 *
 * Tidak mengubah scoring/grading inti. Output dipakai sebagai info tambahan di
 * UI dan tiebreaker ringan di signalEdge.
 */

import { THEME_REGISTRY } from './narrativeDetector';

const THEME_LABELS = THEME_REGISTRY.reduce((map, t) => {
  map[t.id] = t.label;
  return map;
}, {});

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/**
 * Klasifikasi fase token jadi 3 bucket yang jelas buat trader:
 *  - new        : masih di bonding curve / baru deploy
 *  - graduating : bonding hampir penuh (>=80%) — momen migrasi ke Raydium
 *  - migrated   : sudah listing di DEX (Raydium/Orca/Meteora/PumpSwap)
 */
export function classifyPhase(token) {
  const flags = token.flags || {};
  const lp = String(token.lpStatus || '').toLowerCase();
  const dex = String(token.pairDex || token.source || '').toLowerCase();
  const progress = Number(flags.bondingCurveProgress ?? token.curve ?? 0);
  const isBonding = token.phase === 'new'
    || token.phase === 'fresh'
    || lp.includes('bonding');
  const migrated = lp.includes('migrat')
    || token.phase === 'migrated'
    || /raydium|orca|meteora|pumpswap/.test(dex);

  if (migrated && !isBonding) {
    return { key: 'migrated', label: 'Migrated', tone: 'good', bondingProgress: 100 };
  }
  if (isBonding) {
    if (progress >= 80) {
      return { key: 'graduating', label: 'Graduating Soon', tone: 'watch', bondingProgress: progress };
    }
    return { key: 'new', label: 'New / Bonding', tone: 'warn', bondingProgress: progress };
  }
  // phase 'early'/'soon' dari inferPhase = sudah ada pair tapi belum matang.
  if (token.phase === 'soon' || progress >= 80) {
    return { key: 'graduating', label: 'Graduating Soon', tone: 'watch', bondingProgress: progress };
  }
  return { key: 'migrated', label: token.phase === 'early' ? 'Early Migrated' : 'Migrated', tone: 'good', bondingProgress: 100 };
}

/**
 * Ringkas meta/narasi token jadi objek siap-tampil.
 */
function summarizeMeta(token, narrative) {
  const themes = narrative?.themes || [];
  const primaryId = themes[0] || null;
  const external = narrative?.externalThemeLabel || null; // opsional dari AI backend
  const label = external
    || (primaryId ? (THEME_LABELS[primaryId] || primaryId) : 'Tanpa tema jelas');

  return {
    label,
    themeId: primaryId,
    themes,
    isHotMeta: Boolean(narrative?.isHotMeta),
    isSaturated: Boolean(narrative?.isSaturated),
    isFirstMover: Boolean(narrative?.isFirstMover),
    narrativeScore: Number(narrative?.narrativeScore || 0),
    aiLabeled: Boolean(external)
  };
}

/**
 * computeAlpha — gabungkan sinyal alpha jadi skor 0..100 + komponen + alasan.
 *
 * @param {object} token  token feed (idealnya sudah di-enrich on-chain)
 * @param {object} ctx    { narrative, runner, report, social }
 * @returns {{phase, meta, alphaScore, components, reasons}}
 */
export function computeAlpha(token, ctx = {}) {
  const { narrative = null, runner = null, report = null, social = null } = ctx;
  const flags = token.flags || {};
  const phase = classifyPhase(token);
  const meta = summarizeMeta(token, narrative);
  const reasons = [];

  const m5 = Number(token.priceChange?.m5 ?? token.m5 ?? 0);
  const h1 = Number(token.priceChange?.h1 ?? token.h1 ?? 0);
  const buys = Number(flags.buys5m || 0);
  const sells = Number(flags.sells5m || 0);
  const totalTx = buys + sells;
  const buyRatio = totalTx > 0 ? buys / totalTx : 0.5;

  // ── 1. Smart money / KOL / whale (maks 22) — ↓ dari 26 ──
  // Di memecoin, smart money penting tapi lebih penting momentum + buy pressure
  const smartMoney = Number(flags.smartMoneyCount || 0);
  const whales = Number(flags.whales || 0);
  const hasKol = Boolean(flags.kolDetected);
  let smartComp = clamp(smartMoney * 5 + whales * 3 + (hasKol ? 10 : 0), 0, 22);
  if (hasKol) reasons.push(`KOL terdeteksi memegang ${token.ticker}`);
  else if (smartMoney > 0) reasons.push(`${smartMoney} smart wallet di top holder`);

  // ── 2. Momentum (maks 28) — ↑ dari 24 ──
  // Momentum adalah raja di memecoin. Runner score + multi-timeframe price action.
  const runnerScore = Number(runner?.runnerScore || 0);
  let momoComp = runnerScore > 0
    ? clamp(runnerScore * 0.28, 0, 28)
    : clamp(Math.max(0, m5) * 1.4 + Math.max(0, Math.min(h1, 60)) * 0.25, 0, 22);
  if (runnerScore >= 45) reasons.push('Momentum runner kuat');   // ↓ dari 50
  else if (m5 > 4) reasons.push(`Momentum 5m +${m5.toFixed(1)}%`);

  // ── 3. Narasi / meta (maks 22) — ↑ dari 20 ──
  // Narrative/attention adalah price driver #1 di memecoin
  const narrComp = clamp(12 + meta.narrativeScore, 0, 22);
  if (meta.isFirstMover) reasons.push(`First-mover di meta "${meta.label}"`);
  else if (meta.isHotMeta && !meta.isSaturated) reasons.push(`Meta "${meta.label}" sedang panas`);
  else if (meta.isSaturated) reasons.push(`Meta "${meta.label}" sudah saturated (hati-hati copycat)`);

  // ── 4. Kesehatan holder (maks 12) — ↓ dari 14 ──
  let holderComp = 6;
  const top10 = typeof flags.top10Pct === 'number' ? flags.top10Pct : null;
  const commonFunder = typeof flags.commonFunderWallets === 'number' ? flags.commonFunderWallets : null;
  if (top10 != null) {
    if (top10 < 28) holderComp += 5;
    else if (top10 > 58) holderComp -= 5;
  }
  if (commonFunder != null) {
    if (commonFunder <= 1) holderComp += 2;
    else if (commonFunder >= 6) holderComp -= 5;
  }
  holderComp = clamp(holderComp, 0, 12);

  // ── 5. Fase / bonding momentum (maks 12) — ↑ dari 10 ──
  let phaseComp = 0;
  if (phase.key === 'graduating') { phaseComp = 12; reasons.push('Bonding hampir penuh — momen pre-migrasi'); }
  else if (phase.key === 'new') phaseComp = clamp(phase.bondingProgress / 10, 0, 10);
  else if (phase.key === 'migrated') phaseComp = 5;

  // ── 6. Buy pressure (maks 14) — ↑↑ dari 6 ──
  // BUY PRESSURE ADALAH SEGALANYA DI MEMECOIN.
  // Weight dinaikkan signifikan karena ini indikator paling real-time.
  const buyComp = totalTx >= 5
    ? clamp((buyRatio - 0.48) * 40 + Math.min(buys / 4, 4), 0, 14)
    : 0;
  if (buyRatio >= 0.65 && buys >= 10) reasons.push('Buy pressure sangat kuat — demand real');
  else if (buyRatio >= 0.58 && buys >= 8) reasons.push('Buy pressure sehat');

  // ── 7. Volume health (BARU — maks 8) ──
  // Volume yang sehat vs wash trading. Vol/LP ratio rendah + txns cukup = organik.
  let volumeHealthComp = 0;
  const volLiqRatio = Number(flags.volumeLiquidityRatio || 0);
  const txns5m = Number(flags.txns5m || 0);
  if (volLiqRatio > 0 && volLiqRatio < 3 && txns5m >= 15) {
    volumeHealthComp = clamp(8 - volLiqRatio * 1.5, 0, 8);
    if (volumeHealthComp >= 5) reasons.push('Volume organik — bukan wash trading');
  } else if (volLiqRatio >= 8) {
    volumeHealthComp = -3; // penalti untuk volume tidak natural
  }
  volumeHealthComp = clamp(volumeHealthComp, -3, 8);

  // ── 8. Social spike opsional (maks 6) — ↓ dari 8 ──
  let socialComp = 0;
  if (social && Number.isFinite(Number(social.score))) {
    socialComp = clamp(Number(social.score) * 0.06, 0, 6);
    if (social.volumeSpike?.spike) reasons.push('Lonjakan perbincangan sosial terdeteksi');
  }

  const alphaScore = clamp(Math.round(
    smartComp + momoComp + narrComp + holderComp + phaseComp + buyComp + volumeHealthComp + socialComp
  ), 0, 100);

  return {
    phase,
    meta,
    alphaScore,
    components: {
      smartMoney: Math.round(smartComp),
      momentum: Math.round(momoComp),
      narrative: Math.round(narrComp),
      holder: Math.round(holderComp),
      phase: Math.round(phaseComp),
      buyPressure: Math.round(buyComp),
      volumeHealth: Math.round(volumeHealthComp),
      social: Math.round(socialComp)
    },
    reasons: reasons.slice(0, 5)
  };
}

/** Label tier alpha untuk UI — threshold disesuaikan dengan bobot baru. */
export function alphaTier(score) {
  if (score >= 70) return { label: 'Alpha Tinggi', tone: 'good' };       // ↓ dari 75
  if (score >= 50) return { label: 'Alpha Menengah', tone: 'watch' };     // ↓ dari 55
  if (score >= 30) return { label: 'Alpha Rendah', tone: 'warn' };        // ↓ dari 35
  return { label: 'Minim Alpha', tone: 'muted' };
}
