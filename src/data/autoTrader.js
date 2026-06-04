import { analyzeToken } from './apeEngine';
import { analyzeRug } from './rugDetector';
import { analyzeRunner } from './runnerDetector';
import { pushSnapshot, getPeak } from './snapshotStore';
import { buildSignalExplain } from './signalNarrative';
import { fetchDiscoveryFeed, fetchTokenMarketSnapshots, fetchTokenSnapshot } from './liveProviders';
import { fetchHermesSol } from './providers';
import { enrichFeedTokens } from './feedEnrichment';
import { computeExitActions, applyExitActions } from './exitEngine';
import { buildMetaContext, analyzeNarrative } from './narrativeDetector';
import { computeAlpha } from './alphaEngine';
import { buildRegimeBaseline, setCachedBaseline, getCachedBaseline } from './marketRegime';
import { getStyle, loadStyleId, selectSignalsForStyle } from './tradingStyle';

const TRADES_KEY = 'ma_backtest_v2'; // v2 untuk reset data lama
const SIGNALS_KEY = 'ma_signals_v2'; // v2 untuk reset data lama
const SIGNAL_HISTORY_KEY = 'ma_signal_history_v2'; // riwayat semua sinyal yang pernah muncul

/* Grade yang ditampilkan di feed (C disembunyikan). */
const FEED_GRADES = new Set(['A+', 'A', 'B']);
/* Grade yang otomatis di-entry & dilacak. */
const TRACKED_GRADES = new Set(['A+', 'A', 'B']);
/* Grade B = High Risk: hanya "best of the best" yang diloloskan, dibatasi jumlahnya. */
const MAX_B_SIGNALS = 2;
/* Jeda sebelum token yang sama boleh di-entry ulang setelah ditutup. */
const REENTRY_COOLDOWN_MS = 5 * 60 * 1000;

function loadTrades() {
  try {
    const raw = localStorage.getItem(TRADES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
const MAX_CLOSED_TRADES = 200; // arsip dibatasi agar array tidak tumbuh tanpa batas
function saveTrades(list) {
  // Pertahankan semua ACTIVE + maksimum N closed terbaru (urut by closedAt desc).
  const active = list.filter((t) => t.status === 'ACTIVE');
  const closed = list
    .filter((t) => t.status !== 'ACTIVE')
    .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
    .slice(0, MAX_CLOSED_TRADES);
  localStorage.setItem(TRADES_KEY, JSON.stringify([...active, ...closed]));
}
function loadSignals() {
  try {
    const raw = localStorage.getItem(SIGNALS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveSignals(list) {
  localStorage.setItem(SIGNALS_KEY, JSON.stringify(list));
}
function loadSignalHistory() {
  try {
    const raw = localStorage.getItem(SIGNAL_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveSignalHistory(list) {
  localStorage.setItem(SIGNAL_HISTORY_KEY, JSON.stringify(list));
}
function addToSignalHistory(signal) {
  const history = loadSignalHistory();
  // Cek apakah signal ini sudah ada di history (by CA + timestamp dalam 1 menit)
  const exists = history.some(s =>
    s.ca === signal.ca &&
    Math.abs((s.firstSeenAt || 0) - Date.now()) < 60000
  );
  if (!exists) {
    history.unshift({
      ...signal,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now()
    });
    // Keep max 500 signals di history
    if (history.length > 500) history.pop();
    saveSignalHistory(history);
  }
}

export function formatUsd(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0) return '$0';
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(num >= 10_000_000 ? 0 : 1)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(num >= 100_000 ? 0 : 1)}K`;
  if (num < 0.01) {
    const s = num.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
    return `$${s}`;
  }
  return `$${num.toFixed(num >= 10 ? 0 : 2)}`;
}

export function shortAddr(a) {
  if (!a) return '-';
  return `${a.slice(0, 4)}...${a.slice(-4)}`.toUpperCase();
}

/* ─── Signal Grading ─────────────────────────────────────────────────────── */
/* ⚠️ PROFESSIONAL MEMECOIN TRADER CALIBRATION v2:
 * - Entry threshold diperketat: buy pressure, volume minimum, no fresh dump
 * - Confidence lebih realistis (tidak auto-bonus, berdasar data completeness)
 * - Narrative bonus capped agar tidak over-trigger A+ di tema saturated
 * - Micro-cap filter untuk hindari low-liquidity traps
 * - Time-based risk: token terlalu baru (<2 menit) atau terlalu tua di-downgrade
 */
export function gradeSignal(token, report, rug, runner, narrative = null) {
  const price = Number(token.priceUsd || 0);
  const liquidity = Number(token.liquidityUsd || 0);
  const flags = token.flags || {};
  const m5 = Number(token.priceChange?.m5 || 0);
  const h1 = Number(token.priceChange?.h1 || 0);
  const txns5m = Number(flags.txns5m || 0);
  const buys5m = Number(flags.buys5m || 0);
  const sells5m = Number(flags.sells5m || 0);
  const totalTx = buys5m + sells5m;
  const buyRatio = totalTx > 0 ? buys5m / totalTx : 0.5;
  const volume5m = Number(flags.reportedVolume || 0);
  const volLiqRatio = Number(flags.volumeLiquidityRatio || 0);
  const isBonding = token.phase === 'new' || String(token.lpStatus || '').toLowerCase().includes('bonding');
  const ageMin = token.ageMinutes ?? (token.age ? Number(token.age) : null);

  // ── Derived safety signals ──
  // Deteksi fresh dump: M5 turun signifikan tapi sebelumnya ada pump (h1 positif)
  const freshDump = m5 <= -8 && h1 > 5;
  // Deteksi dead cat bounce: M5 naik dikit tapi H1 masih turun tajam
  const deadCatBounce = m5 > 0 && m5 < 5 && h1 < -20;
  // Micro-cap trap: liquidity terlalu kecil untuk non-bonding
  const microCap = !isBonding && liquidity > 0 && liquidity < 8000;

  const checks = {
    scoreHigh: report.score >= 73,           // ↓ dari 75 → sedikit lebih inklusif
    scoreOk: report.score >= 58,             // ↓ dari 60 → tangkap setup decent
    scoreMin: report.score >= 43,            // ↓ dari 45
    noRug: !rug.isRugged && rug.level !== 'critical' && rug.level !== 'high',
    notDead: !rug.isDead,
    runnerScoreHigh: runner.runnerScore >= 52, // ↑ dari 50 → butuh momentum lebih kuat
    runnerScoreOk: runner.runnerScore >= 32,   // ↑ dari 30
    confidence: report.confidence >= 48,       // ↓ dari 50 → threshold realita data feed
    confidenceMin: report.confidence >= 38,    // ↓ dari 40
    liquidityOk: isBonding ? true : liquidity >= 15000,  // ↑ dari 12000 → filter micro-cap
    bondingActive: isBonding ? txns5m >= 10 : true,      // ↑ dari 8 → bonding harus aktif
    momentum: m5 >= -4 && h1 >= -10,           // lebih ketat dari -5/-12
    buyPressure: buyRatio >= 0.55 && buys5m >= 5,  // ↑ dari 0.52 & 3 → ada real demand
    volumeSehat: volLiqRatio < 5.5 && volume5m >= 400 && txns5m >= 12,  // ↑ dari <6 & >0
    noFreeze: flags.freezeActive !== true,
    noOpenMint: flags.mintRevoked !== false,
    concentrationOk: flags.top10Pct == null || flags.top10Pct < 55,  // ↓ dari 58 → lebih ketat
    noBlacklist: flags.madeOnSolBlacklisted !== true,
    // ── Filter baru ──
    noFreshDump: !freshDump,                  // jangan entry pas lagi dump
    noDeadCatBounce: !deadCatBounce,          // jangan tertipu dead cat
    noMicroCap: !microCap,                    // hindari liquidity trap
    notTooFresh: ageMin == null || ageMin >= 2 || isBonding,  // minimal 2 menit (kecuali bonding)
    volumeCredible: volume5m >= 250 || (isBonding && txns5m >= 8),  // minimal ada aktivitas
  };

  // Narrative modifier: capped + hanya untuk tema valid dengan aktivitas on-chain
  const narrativeBonus = narrative
    ? clamp(narrative.narrativeScore, -8, 12)  // cap bonus/penalti → tidak over-trigger
    : 0;
  const adjustedScoreHigh = checks.scoreHigh || (report.score + narrativeBonus >= 74);
  const adjustedScoreOk = checks.scoreOk || (report.score + narrativeBonus >= 58);

  const passed = Object.values(checks).filter(Boolean).length;
  const totalChecks = Object.keys(checks).length;

  let grade = 'C';
  let side = 'SELL';
  let confidence = 0;
  let reasons = [];

  if (checks.noBlacklist && (rug.isRugged || rug.level === 'critical')) {
    grade = 'C';
    side = 'SELL';
    confidence = 96;
    reasons.push('Token terdeteksi bermasalah kritis — hindari entry');
  } else if (checks.noBlacklist && rug.level === 'high') {
    // Rug level high → downgrade ke B maksimal
    grade = 'B';
    side = 'HOLD';
    confidence = Math.round(Math.min(58, report.confidence * 0.7));
    reasons.push('Risiko tinggi terdeteksi — hanya untuk pantauan');
  } else if (adjustedScoreHigh && checks.noRug && checks.notDead && checks.runnerScoreHigh
    && checks.confidence && checks.liquidityOk && checks.momentum && checks.buyPressure
    && checks.volumeSehat && checks.noFreeze && checks.noOpenMint && checks.concentrationOk
    && checks.noFreshDump && checks.noDeadCatBounce && checks.noMicroCap
    && checks.volumeCredible) {
    // A+ butuh SEMUA check hijau termasuk filter baru
    grade = 'A+';
    side = 'BUY';
    // Confidence realistis: base = report confidence, bonus terukur, bukan auto +12
    confidence = Math.min(94, Math.round(
      report.confidence * 0.75 + narrativeBonus * 0.6 + runner.runnerScore * 0.12
    ));
    reasons.push('Setup kuat: momentum, struktur, dan risiko paling seimbang');
    if (narrative && narrative.isHotMeta && !narrative.isSaturated) reasons.push('Tema sedang panas — attention tinggi');
    if (runner.runnerScore >= 70) reasons.push('Runner score superior — momentum sangat kuat');
  } else if (adjustedScoreOk && checks.noRug && checks.notDead && checks.runnerScoreOk
    && checks.confidence && checks.liquidityOk && checks.momentum && checks.buyPressure
    && checks.noFreeze && checks.noOpenMint && checks.noFreshDump
    && checks.volumeCredible) {
    // A: tidak perlu semua check hijau, tapi core safety + momentum harus OK
    grade = 'A';
    side = 'BUY';
    confidence = Math.min(88, Math.round(
      report.confidence * 0.65 + narrativeBonus * 0.5 + runner.runnerScore * 0.1
    ));
    reasons.push('Setup bagus: risiko masih terukur dan layak dipantau');
    if (checks.liquidityOk && liquidity >= 40000) reasons.push('Likuiditas sehat untuk size masuk');
  } else if (checks.scoreMin && checks.noRug && checks.notDead && checks.confidenceMin
    && checks.liquidityOk && checks.noFreshDump) {
    // B: entry pantauan — strukturnya cukup bersih tapi momentum belum konfirmasi penuh
    grade = 'B';
    side = 'HOLD';
    confidence = Math.min(70, Math.round((report.score + narrativeBonus) * 0.85));
    reasons.push('Kondisi menarik tapi belum memenuhi standar entry prioritas');
    if (!checks.momentum) reasons.push('Momentum belum konfirmasi — tunggu pullback sehat');
  } else {
    grade = 'C';
    side = 'SELL';
    confidence = Math.round(Math.max(35, 80 - (passed / totalChecks) * 45));
    reasons.push('Kondisi tidak memenuhi kriteria seleksi — hindari entry');
    if (freshDump) reasons.push('Sedang dump — jangan tangkap falling knife');
    if (microCap) reasons.push('Likuiditas terlalu tipis — risiko tinggi');
    if (deadCatBounce) reasons.push('Dead cat bounce — jangan tertipu pantulan');
  }

  // Downgrade jika narrative sangat negatif (late copycat di tema saturated)
  if (narrative && narrative.isSaturated && !narrative.isFirstMover && narrativeBonus <= -4) {
    if (grade === 'A+') { grade = 'A'; reasons.push('Late copycat di tema saturated — downgrade ke A'); }
    else if (grade === 'A') { grade = 'B'; reasons.push('Late copycat di tema saturated — downgrade ke B'); }
  }

  // Hard safety: kalau buy pressure drop signifikan saat scan → downgrade
  if (buyRatio < 0.45 && totalTx >= 10 && grade === 'A+') {
    grade = 'A';
    reasons.push('Buy pressure melemah signifikan — downgrade');
  }

  return { grade, side, confidence, reasons, checks, passed };
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round1(v) { return Math.round(v * 10) / 10; }

/**
 * SL/TP RELATIF v2 — PROFESSIONAL MEMECOIN CALIBRATION
 *
 * Prinsip utama:
 * 1. SL HARUS lebih lebar dari noise natural memecoin (wick 15-20% normal)
 * 2. TP HARUS realistis — mayoritas memecoin cuma naik 20-50% sebelum reversal
 * 3. RR HARUS grounded di realita — 2.0-3.0 cukup, jangan mimpi 4.0+
 * 4. Volatilitas dihitung multi-timeframe (M5, H1, vol/LP) dengan bobot seimbang
 * 5. Likuiditas tipis → SL lebih lebar (hindari stop hunt oleh whale)
 * 6. Momentum kuat → TP dinaikkan moderat (biarkan winner run, tapi tetap realistis)
 *
 * Target calibration:
 * - A+ : SL 10-14%, TP 25-60%, RR 2.0-3.0
 * - A  : SL 12-18%, TP 20-50%, RR 1.6-2.5
 * - B  : SL 15-22%, TP 18-40%, RR 1.2-1.8
 */
export function deriveSlTp({ grade, confidence, token, runner }) {
  const flags = token.flags || {};
  const m5 = Math.abs(Number(token.priceChange?.m5 ?? token.m5 ?? 0));
  const h1 = Number(token.priceChange?.h1 ?? token.h1 ?? 0);
  const liq = Number(token.liquidityUsd || 0);
  const runnerScore = Number(runner?.runnerScore || 0);
  const volLiqRatio = Number(flags.volumeLiquidityRatio || 0);
  const txns5m = Number(flags.txns5m || 0);

  // ── Proxy volatilitas multi-timeframe (0..45) ──
  // M5 memberi sinyal noise jangka pendek, H1 memberi sinyal tren intraday,
  // vol/LP ratio memberi sinyal wash/aktivitas tidak natural.
  const volatility = clamp(
    m5 * 0.7 + Math.abs(h1) * 0.2 + volLiqRatio * 1.2 + (txns5m > 80 ? 5 : 0),
    0, 45
  );

  // ── Stop Loss: lebih lebar untuk memecoin ──
  // Base SL per grade (sudah include buffer untuk natural wick):
  // A+ = 10% (bukan 8%), A = 13% (bukan 11%), B = 17% (bukan 15%)
  let slPct = grade === 'A+' ? 10 : grade === 'A' ? 13 : 17;

  // Volatilitas tinggi → SL dilebarkan (hindari ke-stop noise)
  slPct += volatility * 0.3;

  // Likuiditas tipis → SL lebih lebar (mudah di-manipulasi whale)
  if (liq > 0 && liq < 12000) slPct += 6;       // micro-cap: sangat volatil
  else if (liq > 0 && liq < 25000) slPct += 4;  // low-cap: masih riskan
  else if (liq > 0 && liq < 50000) slPct += 2;  // mid-cap: moderat
  // Likuiditas > 50000: tidak ada bonus → sudah nyaman

  // Bonding curve: SL sedikit lebih longgar karena harga masih eksplorasi
  const isBonding = token.phase === 'new' || String(token.lpStatus || '').toLowerCase().includes('bonding');
  if (isBonding) slPct += 2;

  slPct = clamp(slPct, 8, 28);  // range 8-28% (sebelumnya 6-26%)

  // ── Risk:Reward — REALISTIS untuk memecoin ──
  // Base RR per grade:
  // A+ = 2.2 (bukan 3.0) → 2.2:1 sudah sangat baik di memecoin
  // A  = 1.8 (bukan 2.4)
  // B  = 1.5 (bukan 1.9)
  let rr = grade === 'A+' ? 2.2 : grade === 'A' ? 1.8 : 1.5;

  // Momentum H1 kuat → naikkan target moderat
  if (h1 > 30) rr += 0.4;
  else if (h1 > 15) rr += 0.2;
  else if (h1 < -8) rr -= 0.3;

  // Runner score tinggi → beri ruang lebih untuk winner
  rr += clamp(runnerScore / 120, 0, 0.5);

  // Confidence tinggi → RR lebih baik (setup lebih terkonfirmasi)
  rr += clamp((confidence - 65) / 100, -0.2, 0.3);

  // Likuiditas besar → RR bisa lebih ambisius (market lebih efisien)
  if (liq >= 60000) rr += 0.2;

  rr = clamp(rr, 1.2, 2.8);  // range 1.2-2.8 (sebelumnya 1.4-4.0)

  // ── Take Profit: slPct * rr + bonus momentum moderat ──
  let tpPct = slPct * rr + volatility * 0.25;
  // Cap TP di 80% — realistis untuk memecoin (sebelumnya 200%)
  tpPct = clamp(tpPct, 15, 80);

  return { slPct: round1(slPct), tpPct: round1(tpPct), rr: round1(rr), volatility: round1(volatility) };
}

function chartUrlFor(token) {
  return token.url || token.pairUrl || `https://dexscreener.com/solana/${token.ca}`;
}

function computeBuyRatio(token) {
  const flags = token.flags || {};
  const buys = Number(flags.buys5m || 0);
  const sells = Number(flags.sells5m || 0);
  const total = buys + sells;
  return total > 0 ? buys / total : 0.5;
}

function buildSignal(token, report, rug, runner, narrative = null, alpha = null) {
  const price = Number(token.priceUsd || 0);
  const { grade, side, confidence, reasons } = gradeSignal(token, report, rug, runner, narrative);

  const entry = price > 0 ? price : null;
  const { slPct, tpPct, rr } = deriveSlTp({ grade, confidence, token, runner });
  let sl = null;
  let tp = null;
  if (entry) {
    sl = entry * (1 - slPct / 100);
    tp = entry * (1 + tpPct / 100);
  }

  const explain = buildSignalExplain({ token, report, rug, runner, grade, side, reasons, entry, sl, tp, tpPct, slPct, rr, narrative });

  return {
    id: token.ca,
    ca: token.ca,
    ticker: token.ticker || shortAddr(token.ca),
    name: token.name || 'Unknown',
    grade,
    side,
    confidence,
    reasons,
    score: report.score,
    entry,
    sl,
    tp,
    slPct,
    tpPct,
    rr,
    priceUsd: price,
    liquidityUsd: Number(token.liquidityUsd || 0),
    age: token.age ?? null,
    ageMinutes: token.ageMinutes ?? null,
    m5: token.priceChange?.m5 ?? 0,
    h1: token.priceChange?.h1 ?? 0,
    buyRatio: computeBuyRatio(token),       // dipakai oleh style gate (passesStyleGate)
    runnerScore: Number(runner?.runnerScore || 0), // shortcut agar gate tidak gali explain
    url: chartUrlFor(token),
    tracked: TRACKED_GRADES.has(grade),
    explain,
    narrative, // tambahkan narrative ke signal object
    alpha,     // fase + meta + alphaScore (lihat alphaEngine.js)
    phase: alpha?.phase?.key || token.phase || 'new',
    alphaScore: Number(alpha?.alphaScore || 0),
    updatedAt: Date.now()
  };
}

function computeSignal(token, metaContext = null, regimeBaseline = null) {
  pushSnapshot(token.ca, token);
  const report = analyzeToken(token, regimeBaseline);
  const rug = analyzeRug(token);
  const runner = analyzeRunner(token, regimeBaseline);
  const narrative = metaContext ? analyzeNarrative(token, metaContext) : null;
  const alpha = computeAlpha(token, { narrative, runner, report });
  return buildSignal(token, report, rug, runner, narrative, alpha);
}

function reevaluateSignal(signal, liveToken) {
  pushSnapshot(liveToken.ca, liveToken);
  const regimeBaseline = getCachedBaseline(); // pakai cached baseline dari scan terakhir
  const report = analyzeToken(liveToken, regimeBaseline);
  const rug = analyzeRug(liveToken);
  const runner = analyzeRunner(liveToken, regimeBaseline);

  const price = Number(liveToken.priceUsd || signal.priceUsd);
  const { grade, side, confidence, reasons } = gradeSignal(liveToken, report, rug, runner, signal.narrative);

  // Entry dikunci di harga pertama sinyal terbentuk (biar PnL berjalan konsisten).
  const entry = signal.entry || (price > 0 ? price : null);
  const { slPct, tpPct, rr } = deriveSlTp({ grade, confidence, token: liveToken, runner });
  let sl = signal.sl;
  let tp = signal.tp;
  if (entry) {
    sl = entry * (1 - slPct / 100);
    tp = entry * (1 + tpPct / 100);
  }

  const explain = buildSignalExplain({
    token: liveToken, report, rug, runner, grade, side, reasons, entry, sl, tp, tpPct, slPct, rr, narrative: signal.narrative
  });

  const alpha = computeAlpha(liveToken, { narrative: signal.narrative, runner, report });

  return {
    ...signal,
    alpha,
    phase: alpha?.phase?.key || signal.phase,
    alphaScore: Number(alpha?.alphaScore || 0),
    priceUsd: price,
    liquidityUsd: Number(liveToken.liquidityUsd || signal.liquidityUsd),
    m5: liveToken.priceChange?.m5 ?? signal.m5,
    h1: liveToken.priceChange?.h1 ?? signal.h1,
    grade,
    side,
    confidence,
    reasons,
    score: report.score,
    entry: entry || signal.entry,
    sl: sl || signal.sl,
    tp: tp || signal.tp,
    slPct,
    tpPct,
    rr,
    url: liveToken.url || signal.url,
    tracked: TRACKED_GRADES.has(grade),
    explain,
    updatedAt: Date.now()
  };
}

const gradeRank = { 'A+': 4, A: 3, B: 2, C: 1 };

/**
 * Edge score v2 — skor kualitas komposit untuk merangking sinyal & menyeleksi B.
 *
 * Rebalance weights untuk realita memecoin:
 * - Momentum & buy pressure lebih penting dari score analisa statis
 * - Alpha/narrative lebih berbobot (attention = price driver #1 di memecoin)
 * - Risk penalty lebih berat (satu red flag bisa membatalkan semua green flag)
 * - Volume integrity tetap penting (wash trading = false signal)
 */
export function signalEdge(s) {
  const ex = s.explain || {};
  const runner = Number(ex.runnerSummary?.score || 0);
  const vol = Number(ex.volumeIntegrity || 0);
  const riskPenalty = { low: 0, medium: 18, high: 42, critical: 80 }[ex.riskNarrative?.level || 'low'] || 0;
  const momentum = (Number(s.m5) || 0) * 0.7 + clamp(Number(s.h1) || 0, -20, 50) * 0.25;
  const buyRatio = Number(s.buyRatio || 0.5);
  const buyBonus = buyRatio >= 0.6 ? (buyRatio - 0.5) * 40 : 0;  // bonus untuk buy pressure kuat
  const alphaScore = Number(s.alphaScore || s.alpha?.alphaScore || 0);
  return (Number(s.score) || 0) * 0.35     // ↓ dari 0.5 — analisa statis kurang penting
    + (Number(s.confidence) || 0) * 0.25    // ↓ dari 0.3
    + runner * 0.30                         // ↑ dari 0.25 — momentum adalah segalanya
    + vol * 0.20                            // ↑ dari 0.15 — integritas volume krusial
    + alphaScore * 0.20                     // ↑ dari 0.1 — narrative/alpha adalah price driver
    + momentum
    + buyBonus
    - riskPenalty;
}

/**
 * Gerbang kualitas grade B (High Risk) v2 — KALIBRASI ULANG.
 *
 * Filosofi baru: B hanya untuk setup yang "hampir A" — struktur bersih,
 * momentum positif, likuiditas memadai, volume kredibel, risiko rendah.
 * BUKAN untuk "apa aja yang nggak fail". Filter lebih ketat di:
 * - Confidence & score (naik)
 * - Runner score (naik)
 * - Buy pressure (cek baru)
 * - Freshness (cek baru — hindari token terlalu tua)
 */
export function isQualityB(s) {
  const ex = s.explain || {};
  const riskLevel = ex.riskNarrative?.level || 'low';
  const runner = Number(ex.runnerSummary?.score || 0);
  const vol = Number(ex.volumeIntegrity || 0);
  const buyRatio = Number(s.buyRatio || 0.5);
  const ageMin = s.ageMinutes ?? (s.age ? Number(s.age) : null);

  // Core safety: hanya risk level low
  if (riskLevel !== 'low') return false;

  // Threshold elevated — B harus genuine "nyaris A"
  if (Number(s.confidence) < 68) return false;    // ↑ dari 65
  if (Number(s.score) < 60) return false;          // ↑ dari 58
  if (runner < 45) return false;                   // ↑ dari 42
  if (vol < 58) return false;                      // ↑ dari 55
  if (Number(s.m5) < -0.5) return false;           // ↑ dari -1
  if (Number(s.h1) < -3) return false;             // ↑ dari -4
  if (Number(s.liquidityUsd) < 30000) return false; // ↑ dari 25000

  // ── Filter baru ──
  if (buyRatio < 0.53) return false;               // harus ada buy pressure minimal
  // Hindari token terlalu matang (>8 jam) — momentum biasanya sudah habis
  if (ageMin != null && ageMin > 480) return false;

  return true;
}

function sortSignals(a, b) {
  if (gradeRank[b.grade] !== gradeRank[a.grade]) return gradeRank[b.grade] - gradeRank[a.grade];
  return signalEdge(b) - signalEdge(a);
}

/**
 * Pindai feed → hitung sinyal → A+/A diutamakan, grade B hanya "best of best"
 * (dibatasi MAX_B_SIGNALS) → auto-track yang lolos.
 */
export async function refreshSignals({ autoTrack = true, styleId = null } = {}) {
  try {
    const feed = await fetchDiscoveryFeed();
    const tokens = feed.tokens || [];
    const scanTokens = tokens.slice(0, 30);

    // ENRICHMENT on-chain (mint/freeze + top holders) untuk kandidat paling
    // tradable SEBELUM grading. Tanpa ini, flags null bikin confidence mentok
    // ~50 dan penalti scoreUnknowns -21 → token bersih tidak pernah naik A/A+.
    // Mutasi in-place: objek yang sama dipakai computeSignal di bawah.
    try {
      const enrichCandidates = [...scanTokens].sort(
        (a, b) => Number(b.liquidityUsd || 0) - Number(a.liquidityUsd || 0)
      );
      await enrichFeedTokens(enrichCandidates, { limit: 15 });
    } catch {
      // Enrichment opsional — kegagalan = fallback ke perilaku lama (degraded).
    }

    // Build meta context dan regime baseline sekali per scan dari seluruh populasi feed
    const metaContext = buildMetaContext(tokens);
    const regimeBaseline = buildRegimeBaseline(tokens);
    setCachedBaseline(regimeBaseline); // cache untuk reevaluateSignal

    const computed = scanTokens
      .map(token => computeSignal(token, metaContext, regimeBaseline))
      .filter((s) => FEED_GRADES.has(s.grade));

    const primary = computed.filter((s) => s.grade === 'A+' || s.grade === 'A');
    const bestB = computed
      .filter((s) => s.grade === 'B' && isQualityB(s))
      .sort((x, y) => signalEdge(y) - signalEdge(x))
      .slice(0, MAX_B_SIGNALS);

    const signals = [...primary, ...bestB].sort(sortSignals);

    // Tambahkan ke signal history
    signals.forEach(s => addToSignalHistory(s));

    saveSignals(signals);

    if (autoTrack) {
      // Style-based rotation: isi slot kosong dengan momentum TERBARU sesuai gaya user.
      // Saat satu posisi close, slot terbuka langsung diisi sinyal terfresh — feed
      // jadi bervariasi, tidak nyangkut di token lama.
      const style = getStyle(styleId || loadStyleId());
      const trades = loadTrades();
      const activeTrades = trades.filter((t) => t.status === 'ACTIVE');
      const recentlyClosed = trades.filter((t) => t.status === 'WIN' || t.status === 'LOSS');

      const picks = selectSignalsForStyle(signals, activeTrades, style, recentlyClosed);
      picks.forEach((sig) => openBacktestTrade(sig, style));
    }
    return signals;
  } catch (e) {
    return loadSignals();
  }
}

/* ─── DCA Engine ────────────────────────────────────────────────────────── */


/* ─── Real-time Price Poll ──────────────────────────────────────────────── */
export async function pollPrices(addresses) {
  const unique = [...new Set(addresses.filter(Boolean))];
  if (!unique.length) return [];
  try {
    return await fetchTokenMarketSnapshots(unique);
  } catch {
    return [];
  }
}

/**
 * Terapkan harga live ke sinyal (re-evaluasi) dan ke trade backtest (resolve WIN/LOSS).
 */
export function applyPriceUpdates(signals, trades, liveTokens) {
  const map = new Map(liveTokens.map((t) => [t.ca, t]));

  const updatedSignals = signals.map((s) => {
    const live = map.get(s.ca);
    if (!live) return { ...s };
    return reevaluateSignal(s, live);
  });

  let tradesChanged = false;
  const updatedTrades = trades.map((t) => {
    if (t.status !== 'ACTIVE') return t;
    const live = map.get(t.ca);
    if (!live) return t;

    // Segarkan snapshot narasi (entry/SL/TP tetap dikunci di nilai trade).
    const snapshot = t.signal ? reevaluateSignal(t.signal, live) : t.signal;
    const currentPrice = Number(live.priceUsd) > 0 ? Number(live.priceUsd) : null;
    if (!currentPrice || !t.entry) {
      tradesChanged = true;
      return { ...t, signal: snapshot };
    }

    // Update peak price untuk trailing stop
    const peakPrice = Math.max(t.peakPrice || t.entry, currentPrice);

    // Compute exit actions dari exit engine
    const { actions, newStop, newStatus, reason, tiers } = computeExitActions(t, currentPrice, live, snapshot);

    if (actions.length === 0) {
      // Tidak ada action, update PnL saja. Persist tiers (status hit) agar tidak dihitung ulang.
      const positionRemaining = t.positionRemaining ?? 1.0;
      const realizedPnl = t.realizedPnl || 0;
      const unrealizedPnl = ((currentPrice - t.entry) / t.entry) * 100 * positionRemaining;
      const pnlPct = realizedPnl + unrealizedPnl;

      tradesChanged = true;
      return { ...t, pnlPct, lastPrice: currentPrice, peakPrice, signal: snapshot, tiers: tiers || t.tiers };
    }

    // Apply exit actions
    tradesChanged = true;
    const updatedTrade = applyExitActions(t, actions, currentPrice);
    updatedTrade.status = newStatus;
    updatedTrade.sl = newStop;
    updatedTrade.lastPrice = currentPrice;
    updatedTrade.peakPrice = peakPrice;
    updatedTrade.signal = snapshot;
    updatedTrade.exitReason = reason;
    updatedTrade.tiers = tiers || updatedTrade.tiers;  // persist tier hit state

    return updatedTrade;
  });

  if (tradesChanged) saveTrades(updatedTrades);
  saveSignals(updatedSignals);
  return { signals: updatedSignals, trades: updatedTrades };
}

export function getCachedSignals() {
  return loadSignals();
}

/* ─── Backtest Trades ───────────────────────────────────────────────────── */
export function getBacktestTrades() {
  return loadTrades();
}

/**
 * Buka trade backtest virtual (tanpa saldo). Menghormati maksimum posisi &
 * cooldown rotasi dari style yang dipilih. Satu trade aktif per token.
 * Mengembalikan trade baru atau null.
 */
export function openBacktestTrade(signal, style = null) {
  if (!signal || !TRACKED_GRADES.has(signal.grade)) return null;
  if (!signal.entry || !signal.sl || !signal.tp) return null;

  const trades = loadTrades();
  if (trades.some((t) => t.ca === signal.ca && t.status === 'ACTIVE')) return null;

  // Batasi jumlah posisi aktif sesuai style (slot penuh = tolak).
  if (style && Number.isFinite(style.maxPositions)) {
    const activeCount = trades.filter((t) => t.status === 'ACTIVE').length;
    if (activeCount >= style.maxPositions) return null;
  }

  // Cooldown re-entry: ambil penutupan PALING BARU untuk CA ini (bukan find pertama).
  const cooldown = style?.rotationCooldownMs ?? REENTRY_COOLDOWN_MS;
  const lastClosedAt = trades
    .filter((t) => t.ca === signal.ca && t.closedAt)
    .reduce((max, t) => Math.max(max, t.closedAt), 0);
  if (lastClosedAt && Date.now() - lastClosedAt < cooldown) return null;

  const now = Date.now();
  const trade = {
    id: 'bt_' + Math.random().toString(36).slice(2, 9),
    ca: signal.ca,
    ticker: signal.ticker,
    name: signal.name,
    grade: signal.grade,
    side: signal.side,
    styleId: signal.styleId || style?.id || null,
    styleTpMultiplier: signal.styleTpMultiplier ?? style?.tpMultiplier ?? 1,
    initialEntry: signal.entry,
    entry: signal.entry,
    sl: signal.sl,
    tp: signal.tp,
    slPct: signal.slPct,
    tpPct: signal.tpPct,
    rr: signal.rr,
    status: 'ACTIVE',
    openedAt: now,
    closedAt: null,
    closePrice: null,
    lastPrice: signal.priceUsd || signal.entry,
    pnlPct: 0,
    positionRemaining: 1.0,
    realizedPnl: 0,
    peakPrice: signal.entry,
    slMovedToBreakeven: false,
    tiers: null,
    exitEvents: [],
    exitReason: null,
    signal: { ...signal }
  };
  trades.unshift(trade);
  saveTrades(trades);
  return trade;
}

/** Statistik backtest dari trade yang sudah selesai (WIN/LOSS). */
export function getBacktestStats() {
  const trades = loadTrades();
  const closed = trades.filter((t) => t.status === 'WIN' || t.status === 'LOSS');
  const wins = closed.filter((t) => t.status === 'WIN');
  const losses = closed.filter((t) => t.status === 'LOSS');
  const active = trades.filter((t) => t.status === 'ACTIVE');

  const avg = (list) => (list.length ? list.reduce((s, t) => s + (t.pnlPct || 0), 0) / list.length : 0);
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;
  const avgWinPct = avg(wins);
  const avgLossPct = avg(losses);
  const lossRate = closed.length ? (losses.length / closed.length) * 100 : 0;
  const expectancy = closed.length
    ? (winRate / 100) * avgWinPct + (lossRate / 100) * avgLossPct
    : 0;
  const allPct = closed.map((t) => t.pnlPct || 0);
  const totalPnlPct = allPct.reduce((s, v) => s + v, 0);
  // Multiple stats: rata-rata multiple saat close (closePrice / initialEntry)
  const multiples = closed
    .filter((t) => t.closePrice && t.initialEntry)
    .map((t) => t.closePrice / t.initialEntry);
  const avgMultiple = multiples.length
    ? multiples.reduce((s, m) => s + m, 0) / multiples.length
    : 0;
  const over3x = multiples.filter((m) => m >= 3).length;
  const over5x = multiples.filter((m) => m >= 5).length;
  const over10x = multiples.filter((m) => m >= 10).length;

  return {
    total: closed.length,
    active: active.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWinPct,
    avgLossPct,
    expectancy,
    totalPnlPct,
    bestPct: allPct.length ? Math.max(...allPct) : 0,
    worstPct: allPct.length ? Math.min(...allPct) : 0,
    avgMultiple,
    over3x,
    over5x,
    over10x
  };
}

export function resetBacktest() {
  saveTrades([]);
  saveSignalHistory([]);
}

export function getSignalHistory() {
  return loadSignalHistory();
}

/**
 * scanDeep — paste-scan satu klik. Ambil snapshot live lengkap lalu jalankan
 * seluruh lapisan analisa (risk + runner + alpha/meta) dan rangkum jadi satu
 * verdict: SAFE / CAUTION / RUG. Mengembalikan superset (field lama tetap ada),
 * jadi konsumen lama tidak rusak.
 */
export async function scanDeep(ca) {
  const [snapshot, solUsd] = await Promise.all([
    fetchTokenSnapshot(ca),
    fetchHermesSol().catch(() => 0)
  ]);
  if (!snapshot) return null;

  pushSnapshot(snapshot.ca, snapshot);
  const report = analyzeToken(snapshot, getCachedBaseline());
  const rug = analyzeRug(snapshot);
  const runner = analyzeRunner(snapshot, getCachedBaseline());
  const metaContext = buildMetaContext([snapshot]);
  const narrative = analyzeNarrative(snapshot, metaContext);
  const alpha = computeAlpha(snapshot, { narrative, runner, report });

  const flags = snapshot.flags || {};
  const isRug = rug.isRugged
    || rug.level === 'critical'
    || rug.level === 'high'
    || flags.freezeActive === true
    || flags.mintRevoked === false
    || flags.madeOnSolBlacklisted === true;
  const isSafe = !isRug
    && report.score >= 70
    && (rug.level === 'low' || rug.level == null)
    && report.confidence >= 70
    && flags.freezeActive !== true
    && flags.mintRevoked === true;

  const verdict = {
    key: isRug ? 'RUG' : isSafe ? 'SAFE' : 'CAUTION',
    label: isRug ? 'BERBAHAYA / RUG' : isSafe ? 'AMAN' : 'HATI-HATI',
    tone: isRug ? 'danger' : isSafe ? 'good' : 'warning',
    primaryRisk: report.primaryRisk,
    rugLevel: rug.level || 'low'
  };

  // Superset: snapshot disebar di root agar pemanggil lama tetap dapat field token.
  return {
    ...snapshot,
    scan: { verdict, report, rug, runner, alpha, narrative },
    verdict,
    phase: alpha.phase,
    meta: alpha.meta,
    alphaScore: alpha.alphaScore,
    solUsd: Number(solUsd || 0)
  };
}
