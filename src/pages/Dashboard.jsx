import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LogOut, RefreshCw, Activity, Trophy, Settings, Bot, Zap, Download,
  TrendingUp, Wallet, ArrowRight, Layers, Flame, Shield, Scale, Power
} from 'lucide-react';
import { useAuth } from '../hooks/useSecureAuth.jsx';
import { useLiveTrading } from '../hooks/useLiveTrading.jsx';
import {
  refreshSignals,
  pollPrices,
  applyPriceUpdates,
  getCachedSignals,
  getBacktestTrades,
  getBacktestStats,
  resetBacktest,
  getSignalHistory,
} from '../data/autoTrader';
import SignalCard from '../components/SignalCard.jsx';
import SignalDetail from '../components/SignalDetail.jsx';
import PasteScanPanel from '../components/PasteScanPanel.jsx';
import PerformancePanel from '../components/PerformancePanel.jsx';
import TradeConfirmationModal from '../components/TradeConfirmationModal.jsx';
import TradingStyleSelector from '../components/TradingStyleSelector.jsx';
import { getStyle, loadStyleId, saveStyleId, TRADING_STYLES } from '../data/tradingStyle';

const TABS = [
  { key: 'home', label: 'Beranda', icon: Bot },
  { key: 'signals', label: 'Sinyal & Posisi', icon: Activity },
  { key: 'scan', label: 'Paste Scan', icon: Zap },
  { key: 'performance', label: 'Performa', icon: Trophy },
];

const HISTORY_RESET_KEY = 'ma_history_reset_v2';

export default function Dashboard({ onLogout }) {
  const { user } = useAuth();
  const liveTrading = useLiveTrading();
  const [tab, setTab] = useState('home');
  const [signals, setSignals] = useState(() => getCachedSignals());
  const [trades, setTrades] = useState(() => getBacktestTrades());
  const [signalHistory, setSignalHistory] = useState(() => getSignalHistory());
  const [scanning, setScanning] = useState(false);
  const [agentOn, setAgentOn] = useState(() => localStorage.getItem('ma_agent_on') !== 'false');
  const [styleId, setStyleId] = useState(() => loadStyleId());
  const [selectedCa, setSelectedCa] = useState(null);
  const [toast, setToast] = useState('');
  const [lastPriceUpdate, setLastPriceUpdate] = useState(null);

  const styleIdRef = useRef(styleId);
  styleIdRef.current = styleId;

  useEffect(() => {
    if (localStorage.getItem(HISTORY_RESET_KEY) !== 'true') {
      resetBacktest();
      setTrades([]);
      localStorage.setItem(HISTORY_RESET_KEY, 'true');
    }
  }, []);

  const agentOnRef = useRef(agentOn);
  agentOnRef.current = agentOn;

  // Guard agar scan tidak tumpang tindih (race condition di interval 20s + ganti style).
  const isRefreshingRef = useRef(false);

  const tradesMap = useMemo(() => {
    const m = new Map();
    trades.filter((t) => t.status === 'ACTIVE').forEach((t) => m.set(t.ca, t));
    return m;
  }, [trades]);

  // Feed yang ditampilkan = trade aktif (tetap tampil sampai SL/TP) digabung
  // sinyal baru dari scan. Trade aktif tidak hilang walau keluar dari discovery.
  const displaySignals = useMemo(() => {
    const rank = { 'A+': 4, A: 3, B: 2, C: 1 };
    const byCa = new Map();
    trades.filter((t) => t.status === 'ACTIVE').forEach((t) => {
      const sig = t.signal || {
        id: t.ca, ca: t.ca, ticker: t.ticker, name: t.name, grade: t.grade, side: t.side,
        confidence: 0, reasons: [], score: 0, priceUsd: t.lastPrice, entry: t.entry,
        sl: t.sl, tp: t.tp, slPct: t.slPct, tpPct: t.tpPct, url: null, tracked: true, explain: {}
      };
      byCa.set(t.ca, sig);
    });
    signals.forEach((s) => { if (!byCa.has(s.ca)) byCa.set(s.ca, s); });
    return Array.from(byCa.values()).sort((a, b) =>
      (rank[b.grade] || 0) - (rank[a.grade] || 0) || (b.confidence || 0) - (a.confidence || 0));
  }, [trades, signals]);

  const stats = useMemo(() => getBacktestStats(), [trades]);

  const counts = useMemo(() => ({
    total: displaySignals.length,
    buy: displaySignals.filter((s) => s.side === 'BUY').length,
    highRisk: displaySignals.filter((s) => s.grade === 'B').length,
  }), [displaySignals]);

  const handleRefreshSignals = async () => {
    // Skip jika scan sebelumnya masih berjalan (hindari race di localStorage).
    if (isRefreshingRef.current) return;
    isRefreshingRef.current = true;
    setScanning(true);
    try {
      const s = await refreshSignals({ autoTrack: agentOnRef.current, styleId: styleIdRef.current });
      setSignals(s);
      setTrades(getBacktestTrades());
      setSignalHistory(getSignalHistory());

      // Auto-execute live trading jika enabled
      if (liveTrading.isEnabled && liveTrading.settings.autoExecute) {
        for (const signal of s) {
          if (['A+', 'A'].includes(signal.grade)) {
            await liveTrading.autoExecuteSignal(signal);
          }
        }
      }
    } finally {
      isRefreshingRef.current = false;
      setScanning(false);
    }
  };

  const handleStyleChange = (newStyleId) => {
    setStyleId(newStyleId);
    saveStyleId(newStyleId);
    const style = getStyle(newStyleId);
    showToast(`Gaya trading: ${style.label} — maks ${style.maxPositions} posisi, grade ${style.allowedGrades.join('/')}`);
    // Trigger scan ulang agar slot langsung menyesuaikan style baru
    setTimeout(() => handleRefreshSignals(), 300);
  };

  // Initial load
  useEffect(() => {
    handleRefreshSignals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh signal feed every 20s
  useEffect(() => {
    const timer = setInterval(() => { handleRefreshSignals(); }, 20000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live price poll every 6s → update signals + resolve trade WIN/LOSS
  useEffect(() => {
    const runPoll = async () => {
      const currentSignals = getCachedSignals();
      const currentTrades = getBacktestTrades();
      const cas = [...new Set([
        ...currentSignals.map((s) => s.ca),
        ...currentTrades.filter((t) => t.status === 'ACTIVE').map((t) => t.ca),
      ])];
      if (!cas.length) return;
      try {
        const liveTokens = await pollPrices(cas);
        if (liveTokens.length) {
          const { signals: nextSignals, trades: nextTrades } = applyPriceUpdates(currentSignals, currentTrades, liveTokens);
          setSignals(nextSignals);
          setTrades(nextTrades);
          setLastPriceUpdate(Date.now());
        }
      } catch { /* abaikan */ }
    };
    runPoll();
    const timer = setInterval(runPoll, 6000);
    return () => clearInterval(timer);
  }, []);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  };

  const toggleAgent = () => {
    const next = !agentOn;
    setAgentOn(next);
    localStorage.setItem('ma_agent_on', String(next));
    showToast(next ? 'Auto-track aktif: sinyal terbaik dilacak otomatis' : 'Auto-track dijeda');
  };

  const handleReset = () => {
    resetBacktest();
    setTrades(getBacktestTrades());
    setSignalHistory(getSignalHistory());
    showToast('Data backtest dan riwayat sinyal telah dikosongkan');
  };

  const selectedSignal = selectedCa
    ? (displaySignals.find((s) => s.ca === selectedCa) || null)
    : null;

  return (
    <div className="dashboard-shell">
      <NavBar user={user} onLogout={onLogout} />

      <div className="tab-bar">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            <Icon size={15} /> {label}
            {key === 'signals' && tradesMap.size > 0 && <span className="tab-count">{tradesMap.size}</span>}
          </button>
        ))}
      </div>

      {tab === 'home' && (
        <HomeTab
          user={user}
          stats={stats}
          signals={displaySignals}
          tradesMap={tradesMap}
          counts={counts}
          agentOn={agentOn}
          onToggleAgent={toggleAgent}
          styleId={styleId}
          onStyleChange={handleStyleChange}
          scanning={scanning}
          lastPriceUpdate={lastPriceUpdate}
          onRefresh={handleRefreshSignals}
          onSelectSignal={(s) => setSelectedCa(s.ca)}
          onGoToSignals={() => setTab('signals')}
          onReset={handleReset}
        />
      )}
      {tab === 'signals' && (
        <SignalsTab
          signals={displaySignals}
          tradesMap={tradesMap}
          counts={counts}
          stats={stats}
          scanning={scanning}
          agentOn={agentOn}
          styleId={styleId}
          lastPriceUpdate={lastPriceUpdate}
          onRefresh={handleRefreshSignals}
          onSelect={(s) => setSelectedCa(s.ca)}
        />
      )}
      {tab === 'scan' && (
        <PasteScanPanel />
      )}
      {tab === 'performance' && (
        <PerformancePanel stats={stats} trades={trades} signalHistory={signalHistory} onReset={handleReset} />
      )}

      {selectedSignal && (
        <SignalDetail
          signal={selectedSignal}
          trade={tradesMap.get(selectedSignal.ca)}
          onClose={() => setSelectedCa(null)}
        />
      )}

      {liveTrading.pendingTrade && (
        <TradeConfirmationModal
          trade={liveTrading.pendingTrade}
          onConfirm={async () => {
            const result = await liveTrading.confirmPendingTrade();
            if (result.success) {
              showToast('✅ Trade berhasil dieksekusi!');
            } else {
              showToast('❌ Trade gagal: ' + result.error);
            }
          }}
          onCancel={liveTrading.cancelPendingTrade}
        />
      )}

      {toast && (
        <div className="toast">{toast}</div>
      )}
    </div>
  );
}

function NavBar({ user, onLogout }) {
  const { exportKeystore, isEncrypted } = useAuth();
  const [exporting, setExporting] = useState(false);

  const handleExportKeystore = async () => {
    if (!isEncrypted) {
      alert('Wallet ini tidak mendukung export keystore');
      return;
    }

    setExporting(true);
    try {
      await exportKeystore();
      alert('Keystore berhasil didownload!');
    } catch (error) {
      alert('Gagal export keystore: ' + error.message);
    } finally {
      setExporting(false);
    }
  };

  const shortAddress = (addr) => {
    if (!addr) return 'Wallet';
    return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
  };

  return (
    <nav className="site-nav">
      <div className="brand">
        <span>AI</span>
        <div>
          <strong>MemeAgent</strong>
          <small>Signal Intelligence Solana</small>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="user-chip">
          <div className="user-chip-avatar">{user?.publicKey?.[0]?.toUpperCase() || 'W'}</div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{shortAddress(user?.publicKey)}</span>
            <small style={{ fontSize: 11, color: 'var(--muted)' }}>
              {user?.balanceSol?.toFixed(4) || '0.0000'} SOL
            </small>
          </div>
        </div>
        {isEncrypted && (
          <button
            type="button"
            className="btn-secondary"
            style={{ padding: '8px 14px', fontSize: 13 }}
            onClick={handleExportKeystore}
            disabled={exporting}
          >
            <Download size={14} /> {exporting ? 'Exporting...' : 'Backup'}
          </button>
        )}
        <button type="button" className="btn-secondary" style={{ padding: '8px 14px', fontSize: 13 }} onClick={onLogout}>
          <LogOut size={14} /> Keluar
        </button>
      </div>
    </nav>
  );
}

const FEED_FILTERS = [
  { key: 'all', label: 'Semua' },
  { key: 'entry', label: 'Layak Entry' },
  { key: 'highrisk', label: 'Selektif B' },
  { key: 'active', label: 'Dilacak' },
];

function SignalsTab({ signals, tradesMap, counts, stats, scanning, agentOn, styleId, lastPriceUpdate, onRefresh, onSelect }) {
  const [filter, setFilter] = useState('all');
  const [showGuide, setShowGuide] = useState(false);
  const style = getStyle(styleId);

  const filterCount = {
    all: counts.total,
    entry: counts.buy,
    highrisk: counts.highRisk,
    active: tradesMap.size,
  };

  const filtered = signals.filter((s) => {
    if (filter === 'entry') return s.grade === 'A+' || s.grade === 'A';
    if (filter === 'highrisk') return s.grade === 'B';
    if (filter === 'active') return tradesMap.has(s.ca);
    return true;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="signal-summary">
        <div className="ss-stat" title="Total sinyal yang sedang tampil"><span>Total Sinyal</span><strong>{counts.total}</strong></div>
        <div className="ss-stat" title="Grade A+/A dengan kualitas entry terbaik"><span>Prioritas Entry</span><strong className="text-green">{counts.buy}</strong></div>
        <div className="ss-stat" title="Grade B hanya tampil jika memenuhi gerbang seleksi tambahan"><span>Grade B Tersaring</span><strong className="text-amber">{counts.highRisk}</strong></div>
        <div className="ss-stat" title="Trade simulasi yang masih dipantau menuju TP/SL"><span>Dalam Pantauan</span><strong className="text-cyan">{tradesMap.size}</strong></div>
        <div className="ss-stat" title="Persentase trade selesai yang berakhir menang"><span>Win Rate</span><strong className={stats.winRate >= 50 ? 'text-green' : 'text-red'}>{stats.total ? `${stats.winRate.toFixed(0)}%` : '—'}</strong></div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h3>Sinyal Pasar <span className="style-tag" style={{ color: style.accent, background: `${style.accent}14` }}>Gaya {style.label}</span></h3>
            <p className="panel-subtitle">Feed backtest untuk membaca peluang, kualitas momentum, dan risiko sebelum sistem digunakan secara real-time.</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {lastPriceUpdate && (
              <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700 }}>
                Harga update {Math.max(0, Math.round((Date.now() - lastPriceUpdate) / 1000))}d lalu
              </span>
            )}
            {agentOn && (
              <span className="scan-mini" style={{ padding: '6px 10px', fontSize: 12 }}>
                <div className="spinner" style={{ width: 12, height: 12 }} />
                Auto-track aktif
              </span>
            )}
            <button type="button" className="btn-secondary" style={{ padding: '8px 14px', fontSize: 13 }} onClick={onRefresh} disabled={scanning}>
              <RefreshCw size={14} style={{ animation: scanning ? 'spin 1s linear infinite' : 'none' }} />
              {scanning ? 'Memindai...' : 'Perbarui Sinyal'}
            </button>
          </div>
        </div>

        <div className="feed-toolbar">
          <div className="filter-chips">
            {FEED_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`chip ${filter === f.key ? 'active' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label} <span className="chip-count">{filterCount[f.key]}</span>
              </button>
            ))}
          </div>
          <button type="button" className="guide-toggle" onClick={() => setShowGuide((v) => !v)}>
            {showGuide ? 'Tutup panduan' : 'Panduan grade'}
          </button>
        </div>

        {showGuide && (
          <div className="feed-legend">
            <div><span className="badge" style={{ background: 'rgba(22,163,74,0.12)', color: 'var(--green)', border: '1px solid rgba(22,163,74,0.28)' }}>A+</span> Prioritas tertinggi: struktur, momentum, dan risiko paling seimbang.</div>
            <div><span className="badge" style={{ background: 'rgba(37,99,235,0.1)', color: 'var(--cyan)', border: '1px solid rgba(37,99,235,0.24)' }}>A</span> Layak dipantau untuk entry dengan risiko yang masih terukur.</div>
            <div><span className="badge" style={{ background: 'rgba(217,119,6,0.12)', color: 'var(--amber)', border: '1px solid rgba(217,119,6,0.26)' }}>B</span> Selektif: hanya muncul jika lolos filter tambahan untuk mengurangi potensi loss.</div>
            <div><span className="sc-status active">DILACAK</span> berarti entry virtual aktif sampai menyentuh TP atau SL. <span className="sc-status win">WIN</span>/<span className="sc-status loss">LOSS</span> adalah hasil simulasi.</div>
            <div className="feed-legend-note">SL/TP menyesuaikan karakter token: volatilitas, likuiditas, momentum, dan keyakinan data. Saat ini masih mode backtest, bukan eksekusi on-chain.</div>
          </div>
        )}

        {scanning && signals.length === 0 ? (
          <div className="signal-grid">
            {Array.from({ length: 6 }).map((_, i) => <div className="signal-card skeleton" key={i} />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            {signals.length === 0
              ? 'Belum ada sinyal yang memenuhi standar seleksi. Klik Perbarui Sinyal untuk memindai ulang.'
              : 'Belum ada sinyal yang cocok dengan filter ini.'}
          </div>
        ) : (
          <div className="signal-grid">
            {filtered.map((s) => (
              <SignalCard key={s.id} signal={s} trade={tradesMap.get(s.ca)} onClick={() => onSelect(s)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const STYLE_ICONS = { conservative: Shield, balanced: Scale, hyper: Flame };

/**
 * HomeTab — Command Center. Satu layar yang menyambungkan semuanya:
 * status agent, gaya trading + slot posisi, posisi berjalan, sinyal terpanas,
 * dan ringkasan performa. Semua klikable & saling terhubung.
 */
function HomeTab({
  user, stats, signals, tradesMap, counts, agentOn, onToggleAgent,
  styleId, onStyleChange, scanning, lastPriceUpdate, onRefresh,
  onSelectSignal, onGoToSignals, onReset,
}) {
  const style = getStyle(styleId);
  const activePositions = Array.from(tradesMap.values());
  const slotsUsed = activePositions.length;
  const slotsTotal = style.maxPositions;

  // Sinyal terpanas yang belum jadi posisi (peluang masuk berikutnya)
  const hotSignals = signals
    .filter((s) => !tradesMap.has(s.ca) && (s.grade === 'A+' || s.grade === 'A'))
    .slice(0, 4);

  const greeting = user?.publicKey
    ? `${user.publicKey.slice(0, 4)}…${user.publicKey.slice(-4)}`
    : 'Trader';

  return (
    <div className="home-grid">
      {/* HERO: status agent + aksi cepat */}
      <div className={`cmd-hero ${agentOn ? 'on' : 'off'}`}>
        <div className="cmd-hero-main">
          <div className="cmd-hero-status">
            <span className="cmd-pulse" />
            {agentOn ? 'Agent sedang memindai pasar' : 'Agent dijeda'}
          </div>
          <h2>Halo, {greeting}</h2>
          <p>
            {agentOn
              ? `Gaya ${style.label} aktif — agent mengisi hingga ${slotsTotal} posisi dan merotasi ke momentum terbaru otomatis.`
              : 'Aktifkan agent untuk mulai melacak sinyal terbaik secara otomatis sesuai gaya trading kamu.'}
          </p>
          <div className="cmd-hero-actions">
            <button type="button" className={`btn-power ${agentOn ? 'on' : ''}`} onClick={onToggleAgent}>
              <Power size={16} /> {agentOn ? 'Jeda Agent' : 'Aktifkan Agent'}
            </button>
            <button type="button" className="btn-ghost" onClick={onRefresh} disabled={scanning}>
              <RefreshCw size={15} style={{ animation: scanning ? 'spin 1s linear infinite' : 'none' }} />
              {scanning ? 'Memindai…' : 'Scan Sekarang'}
            </button>
          </div>
        </div>

        <div className="cmd-hero-balance">
          <span className="label"><Wallet size={13} /> Saldo</span>
          <strong>{(user?.balanceSol ?? 0).toFixed(4)} <em>SOL</em></strong>
          <div className="cmd-slot-meter" title={`${slotsUsed}/${slotsTotal} slot posisi terpakai`}>
            {Array.from({ length: slotsTotal }).map((_, i) => (
              <span key={i} className={`slot-pip ${i < slotsUsed ? 'filled' : ''}`} style={{ '--accent': style.accent }} />
            ))}
          </div>
          <span className="cmd-slot-label">{slotsUsed}/{slotsTotal} posisi aktif</span>
        </div>
      </div>

      {/* QUICK STATS — terhubung ke Performa */}
      <div className="cmd-stats">
        <QuickStat icon={Layers} label="Posisi Aktif" value={slotsUsed} accent="var(--cyan)" />
        <QuickStat icon={Activity} label="Sinyal Live" value={counts.total} accent="var(--blue)" />
        <QuickStat
          icon={Trophy}
          label="Win Rate"
          value={stats.total ? `${stats.winRate.toFixed(0)}%` : '—'}
          accent={stats.winRate >= 50 ? 'var(--green)' : 'var(--amber)'}
        />
        <QuickStat
          icon={TrendingUp}
          label="Total PnL"
          value={stats.total ? `${stats.totalPnlPct >= 0 ? '+' : ''}${stats.totalPnlPct.toFixed(1)}%` : '—'}
          accent={stats.totalPnlPct >= 0 ? 'var(--green)' : 'var(--red)'}
        />
      </div>

      {/* GAYA TRADING — kompak, langsung di beranda */}
      <div className="panel cmd-style">
        <div className="panel-header">
          <div>
            <h3>Gaya Trading</h3>
            <p className="panel-subtitle">Atur ritme agent. Menentukan jumlah posisi & seberapa cepat slot kosong diisi momentum baru.</p>
          </div>
        </div>
        <div className="cmd-style-row">
          {Object.values(TRADING_STYLES).map((st) => {
            const Icon = STYLE_ICONS[st.id] || Scale;
            const active = styleId === st.id;
            return (
              <button
                key={st.id}
                type="button"
                className={`cmd-style-chip ${active ? 'active' : ''}`}
                onClick={() => onStyleChange(st.id)}
                style={{ '--accent': st.accent }}
              >
                <Icon size={18} />
                <span className="cs-label">{st.label}</span>
                <span className="cs-meta">Maks {st.maxPositions} · {st.allowedGrades.join('/')}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* POSISI BERJALAN */}
      <div className="panel">
        <div className="panel-header">
          <div>
            <h3>Posisi Berjalan</h3>
            <p className="panel-subtitle">Entry virtual yang sedang dipantau menuju TP / SL.</p>
          </div>
          {lastPriceUpdate && (
            <span className="cmd-update-chip">
              Harga {Math.max(0, Math.round((Date.now() - lastPriceUpdate) / 1000))}d lalu
            </span>
          )}
        </div>
        {activePositions.length === 0 ? (
          <div className="cmd-empty">
            <p>{agentOn ? 'Belum ada posisi. Agent akan membuka entry begitu menemukan sinyal yang lolos gaya kamu.' : 'Agent dijeda. Aktifkan untuk mulai membuka posisi otomatis.'}</p>
          </div>
        ) : (
          <div className="cmd-position-list">
            {activePositions.map((t) => <PositionRow key={t.ca} trade={t} onClick={() => onSelectSignal(t)} />)}
          </div>
        )}
      </div>

      {/* SINYAL TERPANAS → CTA ke tab Sinyal */}
      <div className="panel">
        <div className="panel-header">
          <div>
            <h3>Peluang Terpanas</h3>
            <p className="panel-subtitle">Sinyal grade A+/A terkuat yang belum jadi posisi.</p>
          </div>
          <button type="button" className="cmd-link" onClick={onGoToSignals}>
            Lihat semua <ArrowRight size={14} />
          </button>
        </div>
        {hotSignals.length === 0 ? (
          <div className="cmd-empty"><p>Belum ada peluang baru. Tekan "Scan Sekarang" untuk memindai ulang.</p></div>
        ) : (
          <div className="cmd-hot-list">
            {hotSignals.map((s) => <HotSignalRow key={s.ca} signal={s} onClick={() => onSelectSignal(s)} />)}
          </div>
        )}
      </div>

      <div className="cmd-footer">
        <button type="button" className="btn-ghost-sm" onClick={onReset}>
          Kosongkan data simulasi
        </button>
        <span className="cmd-mode-note">Mode sinyal & simulasi — belum eksekusi on-chain.</span>
      </div>
    </div>
  );
}

function QuickStat({ icon: Icon, label, value, accent }) {
  return (
    <div className="cmd-stat" style={{ '--accent': accent }}>
      <div className="cmd-stat-icon"><Icon size={16} /></div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function PositionRow({ trade, onClick }) {
  const pnl = Number(trade.pnlPct || 0);
  const up = pnl >= 0;
  return (
    <button type="button" className="cmd-position" onClick={onClick}>
      <div className="cp-token">
        <span className={`cp-grade grade-${trade.grade?.toLowerCase().replace('+', 'plus')}`}>{trade.grade}</span>
        <div>
          <strong>{trade.ticker}</strong>
          <small>{trade.name}</small>
        </div>
      </div>
      <div className={`cp-pnl ${up ? 'up' : 'down'}`}>
        {up ? '+' : ''}{pnl.toFixed(2)}%
      </div>
    </button>
  );
}

function HotSignalRow({ signal, onClick }) {
  return (
    <button type="button" className="cmd-hot" onClick={onClick}>
      <span className={`cp-grade grade-${signal.grade?.toLowerCase().replace('+', 'plus')}`}>{signal.grade}</span>
      <div className="ch-info">
        <strong>{signal.ticker}</strong>
        <small>{signal.confidence}% konfidensi · {Number(signal.m5 || 0) >= 0 ? '+' : ''}{Number(signal.m5 || 0).toFixed(1)}% 5m</small>
      </div>
      <ArrowRight size={15} className="ch-arrow" />
    </button>
  );
}
