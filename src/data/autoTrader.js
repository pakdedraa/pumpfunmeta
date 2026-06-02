import { analyzeToken } from './apeEngine';
import { analyzeRug } from './rugDetector';
import { analyzeRunner } from './runnerDetector';
import { pushSnapshot, getPeak, getLatest } from './snapshotStore';
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
const REENTRY_COOLDOWN_MS = 15 * 60 * 1000; // 15 menit default cooldown
const REENTRY_LOSER_MULT = 2; // cooldown 2x lebih lama kalau trade sebelumnya LOSS
const MAX_REENTRY_PER_TOKEN = 3; // maksimal re-entry 3x per token per sesi

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
    // Presisi adaptif untuk harga memecoin yang sangat kecil. toFixed(10) statis
    // membulatkan harga < 1e-10 menjadi "$0" sehingga "harga live" terlihat tidak
    // konsisten antar token; di sini desimal mengikuti besaran angka.
    const decimals = Math.min(15, Math.max(6, Math.ceil(-Math.log10(num)) + 3));
    const s = num.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
    return `$${s}`;
  }
  return `$${num.toFixed(num >= 10 ? 0 : 2)}`;
}

export function shortAddr(a) {
  if (!a) return '-';
  return `${a.slice(0, 4)}...${a.slice(-4)}`.toUpperCase();
}

/* ─── Signal Grading ─────────────────────────────────────────────────────── */
/* CATATAN: logika analisa/skoring di bawah TIDAK diubah dari versi sebelumnya. */
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

  const checks = {
    scoreHigh: report.score >= 75,
    scoreOk: report.score >= 60,
    scoreMin: report.score >= 45,
    noRug: !rug.isRugged && rug.level !== 'critical' && rug.level !== 'high',
    notDead: !rug.isDead,
    runnerScoreHigh: runner.runnerScore >= 50,
    runnerScoreOk: runner.runnerScore >= 30,
    confidence: report.confidence >= 50,
    confidenceMin: report.confidence >= 40,
    liquidityOk: isBonding ? true : liquidity >= 12000,
    bondingActive: isBonding ? txns5m >= 8 : true,
    momentum: m5 >= -5 && h1 >= -12,
    buyPressure: buyRatio >= 0.52 && buys5m >= 3,
    volumeSehat: volLiqRatio < 6 && volume5m > 0,
    noFreeze: flags.freezeActive !== true,
    noOpenMint: flags.mintRevoked !== false,
    concentrationOk: flags.top10Pct == null || flags.top10Pct < 58,
    noBlacklist: flags.madeOnSolBlacklisted !== true,
  };

  // Narrative modifier: adjust score threshold berdasarkan narrative
  const narrativeBonus = narrative ? narrative.narrativeScore : 0;
  const adjustedScoreHigh = checks.scoreHigh || (report.score + narrativeBonus >= 75);
  const adjustedScoreOk = checks.scoreOk || (report.score + narrativeBonus >= 60);

  const passed = Object.values(checks).filter(Boolean).length;

  let grade = 'C';
  let side = 'SELL';
  let confidence = 0;
  let reasons = [];

  if (checks.noBlacklist && (rug.isRugged || rug.level === 'critical')) {
    grade = 'C';
    side = 'SELL';
    confidence = 96;
    reasons.push('Token terdeteksi bermasalah kritis — hindari entry');
  } else if (adjustedScoreHigh && checks.noRug && checks.notDead && checks.runnerScoreHigh && checks.confidence && checks.liquidityOk && checks.momentum && checks.buyPressure && checks.volumeSehat && checks.noFreeze && checks.noOpenMint && checks.concentrationOk) {
    grade = 'A+';
    side = 'BUY';
    confidence = Math.min(98, Math.round(report.score + narrativeBonus + 12));
    reasons.push('Setup kuat: momentum, struktur, dan risiko paling seimbang');
    if (narrative && narrative.isHotMeta) reasons.push('Tema sedang panas');
  } else if (adjustedScoreOk && checks.noRug && checks.notDead && checks.runnerScoreOk && checks.confidence && checks.liquidityOk && checks.momentum && checks.buyPressure && checks.noFreeze && checks.noOpenMint) {
    grade = 'A';
    side = 'BUY';
    confidence = Math.min(92, Math.round(report.score + narrativeBonus + 6));
    reasons.push('Setup bagus: risiko masih terukur dan layak dipantau');
  } else if (checks.scoreMin && checks.noRug && checks.notDead && checks.confidenceMin && checks.liquidityOk) {
    grade = 'B';
    side = 'HOLD';
    confidence = Math.round((report.score + narrativeBonus) * 0.9);
    reasons.push('Kondisi menarik tapi belum memenuhi standar entry prioritas');
  } else {
    grade = 'C';
    side = 'SELL';
    confidence = Math.round(Math.max(40, 80 - passed * 2));
    reasons.push('Kondisi tidak memenuhi kriteria seleksi — hindari entry');
  }

  // Downgrade jika narrative sangat negatif (late copycat di tema saturated)
  if (narrative && narrative.isSaturated && !narrative.isFirstMover && narrativeBonus < -8) {
    if (grade === 'A+') grade = 'A';
    else if (grade === 'A') grade = 'B';
    reasons.push('Late copycat di tema saturated — risiko exit liquidity tinggi');
  }

  return { grade, side, confidence, reasons, checks, passed };
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round1(v) { return Math.round(v * 10) / 10; }

/**
 * SL/TP RELATIF — dihitung dari profil tiap token, bukan persentase konstan.
 * Faktor: volatilitas (pergerakan harga + rasio vol/likuiditas), kedalaman
 * likuiditas, momentum H1, runner score, grade, dan keyakinan. Token volatil /
 * likuiditas tipis dapat SL lebih lebar (hindari ke-stop noise); momentum &
 * runner kuat menaikkan target TP (biarkan pemenang lari).
 */
export function deriveSlTp({ grade, confidence, token, runner }) {
  const flags = token.flags || {};
  const m5 = Math.abs(Number(token.priceChange?.m5 ?? token.m5 ?? 0));
  const h1 = Number(token.priceChange?.h1 ?? token.h1 ?? 0);
  const liq = Number(token.liquidityUsd || 0);
  const runnerScore = Number(runner?.runnerScore || 0);
  const volLiqRatio = Number(flags.volumeLiquidityRatio || 0);

  // Proxy volatilitas (0..40)
  const volatility = clamp(m5 * 0.8 + Math.abs(h1) * 0.25 + volLiqRatio * 1.5, 0, 40);

  // Stop loss: makin tinggi grade makin ketat; melebar saat volatil / LP tipis
  let slPct = grade === 'A+' ? 8 : grade === 'A' ? 11 : 15;
  slPct += volatility * 0.35;
  if (liq > 0 && liq < 15000) slPct += 4;
  else if (liq > 0 && liq < 40000) slPct += 2;
  slPct = clamp(slPct, 6, 26);

  // Risk:reward dari konviksi + momentum + runner + keyakinan
  let rr = grade === 'A+' ? 3.0 : grade === 'A' ? 2.4 : 1.9;
  if (h1 > 25) rr += 0.5;
  else if (h1 < -5) rr -= 0.3;
  rr += Math.min(0.8, runnerScore / 100);
  rr += clamp((confidence - 60) / 100, -0.3, 0.4);
  rr = clamp(rr, 1.4, 4.0);

  let tpPct = slPct * rr + volatility * 0.4;
  // HAPUS CAP +90% — exit engine sekarang pakai partial TP bertingkat + trailing
  tpPct = clamp(tpPct, 12, 200);

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
 * Edge score — skor kualitas komposit untuk merangking sinyal & menyeleksi B.
 * Menggabungkan skor engine, keyakinan, runner, integritas volume, momentum,
 * dikurangi penalti risiko rug. Makin tinggi = makin layak dipertahankan.
 */
export function signalEdge(s) {
  const ex = s.explain || {};
  const runner = Number(ex.runnerSummary?.score || 0);
  const vol = Number(ex.volumeIntegrity || 0);
  const riskPenalty = { low: 0, medium: 14, high: 34, critical: 70 }[ex.riskNarrative?.level || 'low'] || 0;
  const momentum = (Number(s.m5) || 0) * 0.6 + clamp(Number(s.h1) || 0, -25, 45) * 0.2;
  const alphaScore = Number(s.alphaScore || s.alpha?.alphaScore || 0);
  return (Number(s.score) || 0) * 0.5
    + (Number(s.confidence) || 0) * 0.3
    + runner * 0.25
    + vol * 0.15
    + alphaScore * 0.1   // tiebreaker alpha (tidak mengubah gate grade)
    + momentum
    - riskPenalty;
}

/**
 * Gerbang kualitas grade B (High Risk) — sangat ketat untuk meminimalkan kalah.
 * Hanya B dengan struktur bersih, momentum tidak negatif, likuiditas memadai,
 * volume kredibel, dan risiko rug rendah yang boleh muncul.
 */
export function isQualityB(s) {
  const ex = s.explain || {};
  const riskLevel = ex.riskNarrative?.level || 'low';
  const runner = Number(ex.runnerSummary?.score || 0);
  const vol = Number(ex.volumeIntegrity || 0);
  // Knife-edge dilunakkan: ambang lama dikalibrasi untuk dunia "capped" (sebelum
  // enrichment). Setelah enrichment, distribusi skor/keyakinan naik, jadi ambang
  // ketat lama justru over-filter. Safety inti (riskLevel low, likuiditas, score,
  // confidence) tetap dipertahankan.
  return Number(s.confidence) >= 65
    && Number(s.score) >= 58
    && riskLevel === 'low'
    && runner >= 42
    && vol >= 55
    && Number(s.m5) >= -1
    && Number(s.h1) >= -4
    && Number(s.liquidityUsd) >= 25000;
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
      const byLiquidity = [...scanTokens].sort(
        (a, b) => Number(b.liquidityUsd || 0) - Number(a.liquidityUsd || 0)
      );
      // Sisipkan beberapa token TERBARU di depan antrian enrichment. New pair sering
      // likuiditasnya masih tipis sehingga selalu kalah dari sort-by-liquidity dan
      // tidak pernah di-enrich → grade C → tidak muncul ("new pair kadang gaada").
      // Total budget tetap (limit 15) — hanya komposisinya yang lebih adil.
      const ageOf = (t) => {
        const n = Number(t.ageMinutes ?? t.age);
        return Number.isFinite(n) ? n : Infinity; // umur tak diketahui = jangan rebut slot
      };
      const freshest = [...scanTokens]
        .filter((t) => Number.isFinite(ageOf(t)))
        .sort((a, b) => ageOf(a) - ageOf(b))
        .slice(0, 4);
      const seen = new Set();
      const enrichCandidates = [...freshest, ...byLiquidity].filter((t) => {
        if (!t?.ca || seen.has(t.ca)) return false;
        seen.add(t.ca);
        return true;
      });
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

    // Pre-check SL real-time pakai snapshot store (lebih fresh dari DexScreener cache).
    const snapLatest = getLatest(t.ca);
    const snapPrice = snapLatest?.priceUsd > 0 ? snapLatest.priceUsd : 0;
    const worstPrice = snapPrice > 0 ? Math.min(currentPrice, snapPrice) : currentPrice;

    // Update peak price untuk trailing stop
    const peakPrice = Math.max(t.peakPrice || t.entry, currentPrice);

    // Force SL hit kalau worstPrice sudah di bawah SL (real-time protection).
    if (worstPrice <= t.sl) {
      tradesChanged = true;
      const slTrade = applyExitActions(t, [{ type: 'FULL_EXIT', price: worstPrice, size: t.positionRemaining || 1, reason: 'SL hit (real-time)' }], worstPrice);
      slTrade.status = 'LOSS';
      slTrade.sl = t.sl;
      slTrade.lastPrice = worstPrice;
      slTrade.peakPrice = peakPrice;
      slTrade.signal = snapshot;
      slTrade.exitReason = 'Stop loss tercapai (real-time)';
      return slTrade;
    }

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

  // Cooldown re-entry: ambil penutupan PALING BARU untuk CA ini.
  const closedForCa = trades.filter((t) => t.ca === signal.ca && t.closedAt);
  const lastClosed = closedForCa.reduce((max, t) => (t.closedAt > max.closedAt ? t : max), closedForCa[0] || null);

  // Smart cooldown: lebih lama kalau trade sebelumnya LOSS (hindari revenge trading).
  let cooldown = style?.rotationCooldownMs ?? REENTRY_COOLDOWN_MS;
  if (lastClosed?.status === 'LOSS') cooldown *= REENTRY_LOSER_MULT;
  if (lastClosed && Date.now() - lastClosed.closedAt < cooldown) return null;

  // Max reentry per token per sesi — hindari chasing tanpa batas.
  const reentryCount = closedForCa.length;
  if (reentryCount >= MAX_REENTRY_PER_TOKEN) return null;

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

/**
 * Isi slot posisi yang kosong SEKARANG dari sinyal cache terbaru, tanpa menunggu
 * siklus scan 20s. Dipanggil tiap price-poll (6s) sehingga begitu satu posisi close
 * atau muncul peluang terbaik, slot langsung terisi ("jangan nunggu").
 *
 * Entry di-rebase ke harga LIVE saat entry supaya posisi baru mulai dari ~0% —
 * bukan mewarisi selisih dari harga scan yang sudah basi (sumber PnL tampak aneh).
 * Semua guard (cooldown, maxPositions, dedupe per-CA) tetap lewat openBacktestTrade.
 */
export function fillOpenSlots(styleId = null) {
  const signals = loadSignals();
  const trades = loadTrades();
  if (!signals.length) return trades;

  const style = getStyle(styleId || loadStyleId());
  const activeTrades = trades.filter((t) => t.status === 'ACTIVE');
  if (Number.isFinite(style.maxPositions) && activeTrades.length >= style.maxPositions) {
    return trades; // slot penuh — tidak ada yang perlu diisi
  }

  const recentlyClosed = trades.filter((t) => t.status === 'WIN' || t.status === 'LOSS');
  const picks = selectSignalsForStyle(signals, activeTrades, style, recentlyClosed);
  if (!picks.length) return trades;

  picks.forEach((sig) => {
    const price = Number(sig.priceUsd || sig.entry || 0);
    const slPct = Number(sig.slPct || 0);
    const tpPct = Number(sig.tpPct || 0);
    const rebased = price > 0
      ? { ...sig, entry: price, sl: price * (1 - slPct / 100), tp: price * (1 + tpPct / 100) }
      : sig;
    openBacktestTrade(rebased, style);
  });
  return loadTrades();
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
