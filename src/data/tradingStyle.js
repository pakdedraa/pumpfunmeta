/**
 * tradingStyle.js — Trading Style & Position Rotation Engine
 *
 * Mengatur gaya trading user (Konservatif / Seimbang / Agresif) yang menentukan:
 * - Maksimum posisi aktif bersamaan
 * - Grade sinyal yang diloloskan untuk entry
 * - Profil SL/TP (ketat vs longgar)
 * - Kecepatan rotasi: saat satu posisi close, slot langsung diisi momentum terbaru
 * - Filter momentum (minimal buy pressure, runner score, confidence)
 *
 * Catatan: ini berlaku di mode sinyal/backtest. Saat satu slot kosong, engine
 * mencari sinyal terbaru yang paling fresh & paling kuat sesuai style — sehingga
 * feed tidak "nyangkut" di token lama dan selalu bervariasi.
 */

export const TRADING_STYLES = {
  conservative: {
    id: 'conservative',
    label: 'Konservatif',
    tagline: 'Lambat tapi pasti',
    description: 'Prioritas keamanan modal. Hanya setup grade A+ paling bersih, posisi sedikit, hold lebih sabar.',
    icon: 'Shield',
    accent: '#16a34a',
    maxPositions: 2,
    allowedGrades: ['A+'],
    minConfidence: 80,
    minRunnerScore: 55,
    minBuyRatio: 0.58,
    riskPerTrade: 2,            // % balance per trade (untuk live nanti)
    slMultiplier: 0.85,         // SL lebih ketat (kurangi exposure)
    tpMultiplier: 1.15,         // TP sedikit lebih jauh (tunggu konfirmasi)
    rotationCooldownMs: 8 * 60 * 1000,   // jeda lebih panjang antar rotasi
    freshnessMaxMinutes: 720,   // boleh ambil token agak matang (lebih stabil)
    rotateOnClose: true,
  },
  balanced: {
    id: 'balanced',
    label: 'Seimbang',
    tagline: 'Risk & reward proporsional',
    description: 'Kombinasi grade A+/A. Jumlah posisi menengah, rotasi wajar, mengejar momentum sehat.',
    icon: 'Scale',
    accent: '#0284c7',
    maxPositions: 3,
    allowedGrades: ['A+', 'A'],
    minConfidence: 70,
    minRunnerScore: 40,
    minBuyRatio: 0.54,
    riskPerTrade: 3,
    slMultiplier: 1.0,
    tpMultiplier: 1.0,
    rotationCooldownMs: 4 * 60 * 1000,
    freshnessMaxMinutes: 360,
    rotateOnClose: true,
  },
  hyper: {
    id: 'hyper',
    label: 'Agresif (Hyper)',
    tagline: 'Cepat profit, high risk high return',
    description: 'Kejar momentum terpanas grade A+/A dan B terpilih. Posisi banyak, rotasi kilat begitu satu slot close.',
    icon: 'Flame',
    accent: '#dc2626',
    maxPositions: 5,
    allowedGrades: ['A+', 'A', 'B'],
    minConfidence: 62,
    minRunnerScore: 30,
    minBuyRatio: 0.5,
    riskPerTrade: 5,
    slMultiplier: 1.2,          // SL lebih longgar (biarkan breathe untuk runner)
    tpMultiplier: 0.9,          // TP lebih dekat untuk realisasi cepat tier awal
    rotationCooldownMs: 90 * 1000,       // rotasi sangat cepat
    freshnessMaxMinutes: 180,   // hanya kejar yang masih fresh / panas
    rotateOnClose: true,
  },
};

export const DEFAULT_STYLE_ID = 'balanced';
const STYLE_KEY = 'ma_trading_style';

export function getStyle(styleId) {
  return TRADING_STYLES[styleId] || TRADING_STYLES[DEFAULT_STYLE_ID];
}

export function loadStyleId() {
  try {
    const saved = localStorage.getItem(STYLE_KEY);
    return saved && TRADING_STYLES[saved] ? saved : DEFAULT_STYLE_ID;
  } catch {
    return DEFAULT_STYLE_ID;
  }
}

export function saveStyleId(styleId) {
  if (TRADING_STYLES[styleId]) {
    localStorage.setItem(STYLE_KEY, styleId);
  }
}

/**
 * Skor "freshness + momentum" sebuah sinyal untuk style tertentu.
 * Dipakai untuk memilih kandidat terbaik saat mengisi slot kosong.
 * Makin tinggi = makin layak diambil sekarang.
 */
/** Umur token dalam menit; null/tak diketahui dianggap 0 (fresh) agar tidak salah tolak. */
function ageMinutesOf(signal) {
  const v = signal.ageMinutes ?? signal.age;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Runner score dengan fallback berlapis (shortcut field → explain). */
function runnerScoreOf(signal) {
  return Number(signal.runnerScore ?? signal.explain?.runnerSummary?.score ?? 0);
}

/** Buy ratio dengan fallback ke explain bila ada, default netral 0.5. */
function buyRatioOf(signal) {
  return Number(signal.buyRatio ?? signal.explain?.orderFlow?.buyRatio ?? 0.5);
}

export function momentumScore(signal, style) {
  const ageMin = ageMinutesOf(signal);
  const m5 = Number(signal.m5 || 0);
  const h1 = Number(signal.h1 || 0);
  const confidence = Number(signal.confidence || 0);
  const runner = runnerScoreOf(signal);
  const gradeRank = { 'A+': 30, A: 20, B: 8, C: 0 }[signal.grade] || 0;

  // Penalti umur: makin tua makin turun, dipertajam untuk style hyper
  const freshnessWindow = style.freshnessMaxMinutes;
  const agePenalty = Math.min(40, (ageMin / freshnessWindow) * 40);

  // Bonus momentum jangka pendek (style hyper lebih sensitif ke m5)
  const m5Weight = style.id === 'hyper' ? 1.4 : style.id === 'balanced' ? 1.0 : 0.6;
  // Momentum SWEET-SPOT: hadiah naik untuk m5 sehat (s.d. ~25%) lalu MENURUN untuk
  // m5 parabolik. Sebelumnya batas 12% terlalu ketat — memecoin early runner sering
  // punya m5 15-30% dan justru itu sinyal kuat. Batas dinaikkan ke 25% agar tidak
  // menghukum momentum awal yang valid.
  const healthyM5 = Math.min(Math.max(m5, -20), 25);
  const excessM5 = Math.max(0, m5 - 25);
  const m5Signal = healthyM5 * m5Weight - excessM5 * (m5Weight * 0.7);
  // Penalti "sudah lari jauh": h1 sangat tinggi = peluang entry telat (exit liquidity).
  const extendedPenalty = h1 > 120 ? Math.min(25, (h1 - 120) * 0.12) : 0;
  const momentum = m5Signal + Math.max(-20, Math.min(40, h1)) * 0.25 - extendedPenalty;

  return gradeRank
    + confidence * 0.35
    + runner * 0.25
    + momentum
    - agePenalty;
}

/**
 * Apakah sinyal memenuhi gate minimum style untuk boleh di-entry.
 */
export function passesStyleGate(signal, style) {
  if (!style.allowedGrades.includes(signal.grade)) return false;
  if (Number(signal.confidence || 0) < style.minConfidence) return false;

  const runner = runnerScoreOf(signal);
  if (runner < style.minRunnerScore) return false;

  const buyRatio = buyRatioOf(signal);
  if (buyRatio < style.minBuyRatio) return false;

  // Freshness gate: hanya tolak jika umur DIKETAHUI dan melebihi ambang style.
  const ageMin = ageMinutesOf(signal);
  if (ageMin > 0 && ageMin > style.freshnessMaxMinutes * 1.5) return false;

  // Anti "buy pucuk": jangan auto-entry di candle yang sudah vertikal / kelewat jauh.
  // Sinyal tetap MUNCUL di feed (grading tidak diubah), hanya auto-entry yang ditahan
  // supaya tidak masuk tepat di puncak lalu kena SL saat harga koreksi/rebound.
  const m5 = Number(signal.m5 || 0);
  const h1 = Number(signal.h1 || 0);
  if (m5 >= 35) return false;              // candle 5m blow-off (parabolik)
  if (h1 >= 200 && m5 >= 8) return false;  // sudah +200%/jam dan masih spiking → telat
  if (h1 > 60 && m5 <= -8) return false;   // pump 1 jam sudah berbalik turun → puncak

  return true;
}

/**
 * Terapkan style ke SL/TP sebuah sinyal (sesuaikan ketat/longgar).
 * Mengembalikan sinyal baru dengan sl/tp/slPct/tpPct yang disesuaikan.
 */
export function applyStyleToSignal(signal, style) {
  if (!signal.entry) return signal;

  // Clamp ke batas desain risiko (samakan dengan deriveSlTp di autoTrader).
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const slPct = clamp(Number(signal.slPct || 0) * style.slMultiplier, 6, 26);
  const tpPct = clamp(Number(signal.tpPct || 0) * style.tpMultiplier, 12, 200);

  return {
    ...signal,
    slPct: Math.round(slPct * 10) / 10,
    tpPct: Math.round(tpPct * 10) / 10,
    sl: signal.entry * (1 - slPct / 100),
    tp: signal.entry * (1 + tpPct / 100),
    styleId: style.id,
    styleTpMultiplier: style.tpMultiplier,  // diteruskan ke exit engine untuk skala tier
  };
}

/**
 * Pilih sinyal-sinyal terbaik untuk MENGISI SLOT yang tersedia, sesuai style.
 *
 * @param {Array} candidateSignals - semua sinyal hasil scan terbaru
 * @param {Array} activeTrades - trade yang masih ACTIVE
 * @param {object} style - objek style
 * @param {Array} recentlyClosed - trade yang baru close (untuk cooldown re-entry)
 * @returns {Array} sinyal terpilih untuk entry (sudah di-apply style SL/TP)
 */
export function selectSignalsForStyle(candidateSignals, activeTrades, style, recentlyClosed = []) {
  const activeCas = new Set(activeTrades.map((t) => t.ca));
  const now = Date.now();

  // CA yang masih dalam cooldown rotasi (baru saja ditutup)
  const cooldownCas = new Set(
    recentlyClosed
      .filter((t) => t.closedAt && now - t.closedAt < style.rotationCooldownMs)
      .map((t) => t.ca)
  );

  const slotsAvailable = Math.max(0, style.maxPositions - activeTrades.length);
  if (slotsAvailable === 0) return [];

  const eligible = candidateSignals
    .filter((s) => !activeCas.has(s.ca))      // belum dipegang
    .filter((s) => !cooldownCas.has(s.ca))    // tidak dalam cooldown
    .filter((s) => passesStyleGate(s, style)) // lolos gate style
    .map((s) => ({ signal: s, score: momentumScore(s, style) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, slotsAvailable)
    .map(({ signal }) => applyStyleToSignal(signal, style));

  return eligible;
}

/**
 * Ringkasan status style untuk UI.
 */
export function buildStyleStatus(style, activeTrades) {
  const slotsUsed = activeTrades.length;
  const slotsTotal = style.maxPositions;
  return {
    styleId: style.id,
    label: style.label,
    slotsUsed,
    slotsTotal,
    slotsAvailable: Math.max(0, slotsTotal - slotsUsed),
    isFull: slotsUsed >= slotsTotal,
    accent: style.accent,
  };
}
