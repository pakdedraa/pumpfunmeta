import { Trophy, RotateCcw, History, ChevronLeft, ChevronRight, X, TrendingUp, TrendingDown, Activity, Copy, Check } from 'lucide-react';
import { useState } from 'react';
import { formatUsd } from '../data/autoTrader';

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback: ignore
    }
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      title="Copy CA"
      style={{
        background: 'transparent',
        border: '1px solid var(--line)',
        borderRadius: 4,
        padding: '2px 6px',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        color: copied ? 'var(--green)' : 'var(--muted)'
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function StatBox({ label, value, tone, sub }) {
  const cls = tone === 'up' ? 'text-green' : tone === 'down' ? 'text-red' : tone === 'cyan' ? 'text-cyan' : '';
  return (
    <div className="perf-stat">
      <span>{label}</span>
      <strong className={cls}>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}

/* Kurva ekuitas: PnL% kumulatif dari trade yang sudah selesai (diurutkan berdasarkan waktu penutupan). */
function EquityCurve({ trades }) {
  const closed = trades
    .filter((t) => t.status === 'WIN' || t.status === 'LOSS')
    .sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));

  if (closed.length < 2) {
    return <div className="perf-curve empty">Kurva ekuitas tersedia setelah minimal 2 trade selesai.</div>;
  }

  let cum = 0;
  const points = closed.map((t) => (cum += (t.pnlPct || 0)));
  const min = Math.min(0, ...points);
  const max = Math.max(0, ...points);
  const range = max - min || 1;
  const W = 100;
  const H = 36;
  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * W;
    const y = H - ((p - min) / range) * H;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const zeroY = H - ((0 - min) / range) * H;
  const last = points[points.length - 1];
  const color = last >= 0 ? 'var(--green)' : 'var(--red)';

  return (
    <div className="perf-curve">
      <div className="perf-curve-head">
        <span>Kurva Ekuitas (PnL% kumulatif)</span>
        <strong className={last >= 0 ? 'text-green' : 'text-red'}>{last >= 0 ? '+' : ''}{last.toFixed(1)}%</strong>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="perf-curve-svg">
        <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="var(--line)" strokeWidth="0.5" strokeDasharray="2 2" />
        <polyline points={coords.join(' ')} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

export default function PerformancePanel({ stats, trades = [], signalHistory = [], onReset }) {
  const fmt = (n, plus = false) => `${plus && n > 0 ? '+' : ''}${(n || 0).toFixed(1)}%`;
  const [historyPage, setHistoryPage] = useState(0);
  const [selectedSignal, setSelectedSignal] = useState(null);
  const ITEMS_PER_PAGE = 20;

  // Hanya tampilkan signal yang sudah punya trade selesai (WIN/LOSS)
  const closedHistory = signalHistory.filter((item) => {
    const matched = trades.find((t) => t.ca === item.ca);
    return matched && (matched.status === 'WIN' || matched.status === 'LOSS');
  });

  // Deduplicate by CA — keep the newest entry for each token
  const uniqueHistory = closedHistory.filter((item, index, self) =>
    index === self.findIndex((t) => t.ca === item.ca)
  );

  const totalPages = Math.ceil(uniqueHistory.length / ITEMS_PER_PAGE);
  const paginatedHistory = uniqueHistory.slice(
    historyPage * ITEMS_PER_PAGE,
    (historyPage + 1) * ITEMS_PER_PAGE
  );

  const gradeColor = (grade) => {
    if (grade === 'A+') return 'var(--green)';
    if (grade === 'A') return 'var(--cyan)';
    if (grade === 'B') return 'var(--amber)';
    return 'var(--muted)';
  };

  const formatTime = (timestamp) => {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <h3><Trophy size={16} style={{ verticalAlign: '-3px', marginRight: 6, color: 'var(--amber)' }} /> Performa Simulasi</h3>
        {onReset && (
          <button type="button" className="btn-secondary" style={{ padding: '8px 14px', fontSize: 13 }} onClick={onReset}>
            <RotateCcw size={14} /> Reset
          </button>
        )}
      </div>

      {stats.total === 0 && stats.active === 0 ? (
        <div className="empty-state">Belum ada data simulasi. Sinyal dengan grade terbaik akan otomatis dilacak begitu muncul.</div>
      ) : (
        <>
          <div className="perf-grid">
            <StatBox label="Win Rate" value={`${stats.winRate.toFixed(0)}%`} tone={stats.winRate >= 50 ? 'up' : 'down'} sub={`${stats.wins}W / ${stats.losses}L`} />
            <StatBox label="Trade Selesai" value={stats.total} sub={`${stats.active} dilacak`} />
            <StatBox label="Rata-rata Profit" value={fmt(stats.avgWinPct, true)} tone="up" />
            <StatBox label="Rata-rata Loss" value={fmt(stats.avgLossPct)} tone="down" />
            <StatBox label="Ekspektansi / Trade" value={fmt(stats.expectancy, true)} tone={stats.expectancy >= 0 ? 'up' : 'down'} />
            <StatBox label="Total PnL" value={fmt(stats.totalPnlPct, true)} tone={stats.totalPnlPct >= 0 ? 'up' : 'down'} />
            <StatBox label="Trade Terbaik" value={fmt(stats.bestPct, true)} tone="up" />
            <StatBox label="Trade Terburuk" value={fmt(stats.worstPct)} tone="down" />
            <StatBox label="Avg Multiple" value={`${(stats.avgMultiple || 0).toFixed(1)}x`} tone={stats.avgMultiple >= 2 ? 'up' : 'cyan'} sub="saat exit" />
            <StatBox label="Runner >3x" value={stats.over3x || 0} tone="up" sub={`dari ${stats.total} trade`} />
            <StatBox label="Runner >5x" value={stats.over5x || 0} tone="up" sub={`dari ${stats.total} trade`} />
            <StatBox label="Moon >10x" value={stats.over10x || 0} tone="up" sub={`dari ${stats.total} trade`} />
          </div>

          <EquityCurve trades={trades} />

          <div className="perf-bar">
            <div className="perf-bar-fill" style={{ width: `${Math.min(100, stats.winRate)}%` }} />
            <span>{stats.wins} menang · {stats.losses} kalah dari {stats.total} trade selesai</span>
          </div>

          <p className="perf-note">
            Ekspektansi adalah rata-rata hasil per trade dengan memperhitungkan win rate. Nilai positif
            menandakan strategi ini menguntungkan dalam simulasi. Mode backtest, bukan eksekusi nyata.
          </p>
        </>
      )}

      {/* Riwayat Trade Selesai (closed trades only) */}
      {uniqueHistory.length > 0 && (
        <div style={{ marginTop: 24, borderTop: '1px solid var(--line)', paddingTop: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <h4 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0, fontSize: 15, color: 'var(--soft)' }}>
              <History size={16} style={{ color: 'var(--cyan)' }} />
              Riwayat Trade Selesai ({uniqueHistory.length})
            </h4>
            {totalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setHistoryPage(p => Math.max(0, p - 1))}
                  disabled={historyPage === 0}
                  style={{ opacity: historyPage === 0 ? 0.4 : 1 }}
                >
                  <ChevronLeft size={14} />
                </button>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {historyPage + 1} / {totalPages}
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setHistoryPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={historyPage >= totalPages - 1}
                  style={{ opacity: historyPage >= totalPages - 1 ? 0.4 : 1 }}
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            )}
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--line)', color: 'var(--muted)' }}>
                  <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600 }}>Token</th>
                  <th style={{ textAlign: 'center', padding: '8px 12px', fontWeight: 600 }}>Grade</th>
                  <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600 }}>Entry</th>
                  <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600 }}>TP</th>
                  <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600 }}>SL</th>
                  <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600 }}>PnL</th>
                  <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600 }}>Liquidity</th>
                  <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600 }}>Waktu</th>
                </tr>
              </thead>
              <tbody>
                {paginatedHistory.map((signal, i) => {
                  // Cari trade yang match dengan signal ini
                  const matchedTrade = trades.find(t => t.ca === signal.ca);
                  const pnl = matchedTrade?.pnlPct || null;
                  const status = matchedTrade?.status;

                  return (
                    <tr
                      key={`${signal.ca}-${i}`}
                      style={{
                        borderBottom: '1px solid var(--line)',
                        cursor: 'pointer',
                        transition: 'background 0.15s'
                      }}
                      onClick={() => setSelectedSignal(signal)}
                      onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-secondary)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                      <td style={{ padding: '10px 12px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <strong style={{ fontSize: 13 }}>${signal.ticker}</strong>
                          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{signal.name}</span>
                        </div>
                      </td>
                      <td style={{ textAlign: 'center', padding: '10px 12px' }}>
                        <span style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          borderRadius: 4,
                          fontSize: 11,
                          fontWeight: 700,
                          color: gradeColor(signal.grade),
                          background: `${gradeColor(signal.grade)}22`,
                          border: `1px solid ${gradeColor(signal.grade)}44`
                        }}>
                          {signal.grade}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right', padding: '10px 12px', color: 'var(--soft)' }}>
                        {signal.entry ? formatUsd(signal.entry) : '-'}
                      </td>
                      <td style={{ textAlign: 'right', padding: '10px 12px', color: 'var(--green)', fontSize: 12 }}>
                        {signal.tpPct ? `+${signal.tpPct.toFixed(1)}%` : '-'}
                      </td>
                      <td style={{ textAlign: 'right', padding: '10px 12px', color: 'var(--red)', fontSize: 12 }}>
                        {signal.slPct ? `-${signal.slPct.toFixed(1)}%` : '-'}
                      </td>
                      <td style={{ textAlign: 'right', padding: '10px 12px' }}>
                        {pnl != null ? (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                            {pnl >= 0 ? <TrendingUp size={14} style={{ color: 'var(--green)' }} /> : <TrendingDown size={14} style={{ color: 'var(--red)' }} />}
                            <strong style={{ color: pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                              {pnl >= 0 ? '+' : ''}{pnl.toFixed(1)}%
                            </strong>
                            {status && (
                              <span style={{
                                fontSize: 9,
                                padding: '1px 4px',
                                borderRadius: 3,
                                background: status === 'WIN' ? 'var(--green)' : status === 'LOSS' ? 'var(--red)' : 'var(--cyan)',
                                color: 'white',
                                fontWeight: 700,
                                marginLeft: 4
                              }}>
                                {status}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: 'var(--muted)', fontSize: 11 }}>-</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', padding: '10px 12px', color: 'var(--soft)' }}>
                        {formatUsd(signal.liquidityUsd)}
                      </td>
                      <td style={{ textAlign: 'right', padding: '10px 12px', fontSize: 11, color: 'var(--muted)' }}>
                        {formatTime(signal.firstSeenAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal Detail Signal */}
      {selectedSignal && (
        <SignalHistoryModal
          signal={selectedSignal}
          trade={trades.find(t => t.ca === selectedSignal.ca)}
          onClose={() => setSelectedSignal(null)}
        />
      )}
    </div>
  );
}

function SignalHistoryModal({ signal, trade, onClose }) {
  const ex = signal.explain || {};
  const pnl = trade?.pnlPct || null;
  const status = trade?.status;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: 20
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg)',
          borderRadius: 12,
          maxWidth: 700,
          width: '100%',
          maxHeight: '90vh',
          overflow: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: '20px 24px',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          position: 'sticky',
          top: 0,
          background: 'var(--bg)',
          zIndex: 1
        }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
              ${signal.ticker}
              <span style={{
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 700,
                color: signal.grade === 'A+' ? 'var(--green)' : signal.grade === 'A' ? 'var(--cyan)' : 'var(--amber)',
                background: signal.grade === 'A+' ? 'rgba(22,163,74,0.15)' : signal.grade === 'A' ? 'rgba(37,99,235,0.15)' : 'rgba(217,119,6,0.15)',
                border: `1px solid ${signal.grade === 'A+' ? 'rgba(22,163,74,0.3)' : signal.grade === 'A' ? 'rgba(37,99,235,0.3)' : 'rgba(217,119,6,0.3)'}`
              }}>
                {signal.grade}
              </span>
            </h3>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>{signal.name}</p>
            {signal.ca && (
              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                <code style={{ fontSize: 11, color: 'var(--soft)', background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: 4, wordBreak: 'break-all' }}>
                  {signal.ca}
                </code>
                <CopyButton text={signal.ca} />
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 8,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              color: 'var(--muted)'
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: 24 }}>

          {/* DexScreener Chart Embed */}
          <div style={{ marginBottom: 20, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--line)', background: 'var(--bg-secondary)' }}>
            <iframe
              src={`https://dexscreener.com/solana/${signal.ca}?embed=1&theme=dark&info=0`}
              title="DexScreener Chart"
              style={{ width: '100%', height: 380, border: 'none', display: 'block' }}
              sandbox="allow-scripts allow-same-origin"
            />
          </div>

          {/* PnL Summary */}
          {pnl != null && (
            <div style={{
              padding: 16,
              borderRadius: 8,
              background: pnl >= 0 ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)',
              border: `1px solid ${pnl >= 0 ? 'rgba(22,163,74,0.3)' : 'rgba(220,38,38,0.3)'}`,
              marginBottom: 20
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>Profit & Loss</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong style={{ fontSize: 24, color: pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}%
                  </strong>
                  {status && (
                    <span style={{
                      fontSize: 11,
                      padding: '4px 8px',
                      borderRadius: 4,
                      background: status === 'WIN' ? 'var(--green)' : status === 'LOSS' ? 'var(--red)' : 'var(--cyan)',
                      color: 'white',
                      fontWeight: 700
                    }}>
                      {status}
                    </span>
                  )}
                </div>
              </div>
              {trade && (
                <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, fontSize: 12 }}>
                  <div>
                    <span style={{ color: 'var(--muted)', display: 'block' }}>Posisi Tersisa</span>
                    <strong style={{ color: 'var(--soft)' }}>{((trade.positionRemaining || 1) * 100).toFixed(0)}%</strong>
                  </div>
                  {trade.realizedPnl != null && trade.realizedPnl !== 0 && (
                    <div>
                      <span style={{ color: 'var(--muted)', display: 'block' }}>Realized PnL</span>
                      <strong style={{ color: trade.realizedPnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {trade.realizedPnl >= 0 ? '+' : ''}{trade.realizedPnl.toFixed(2)}%
                      </strong>
                    </div>
                  )}
                  {trade.peakPrice && trade.peakPrice > (trade?.entry || signal.entry || 0) && (
                    <div>
                      <span style={{ color: 'var(--muted)', display: 'block' }}>Peak</span>
                      <strong style={{ color: 'var(--cyan)' }}>
                        +{(((trade.peakPrice - (trade?.entry || signal.entry)) / (trade?.entry || signal.entry)) * 100).toFixed(1)}%
                      </strong>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Entry Levels — pakai trade object (karena ini trade history, bukan sinyal live) */}
          <div style={{ marginBottom: 20 }}>
            <h4 style={{ fontSize: 14, margin: '0 0 12px', color: 'var(--soft)' }}>Entry & Levels</h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
              <div style={{ padding: 12, background: 'var(--bg-secondary)', borderRadius: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Entry Price</span>
                <strong style={{ fontSize: 15, color: 'var(--soft)' }}>{(trade?.entry || signal.entry) ? formatUsd(trade?.entry || signal.entry) : '-'}</strong>
              </div>
              <div style={{ padding: 12, background: 'var(--bg-secondary)', borderRadius: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Liquidity</span>
                <strong style={{ fontSize: 15, color: 'var(--soft)' }}>{formatUsd(signal.liquidityUsd)}</strong>
              </div>
              <div style={{ padding: 12, background: 'rgba(22,163,74,0.1)', borderRadius: 6, border: '1px solid rgba(22,163,74,0.2)' }}>
                <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Take Profit</span>
                <strong style={{ fontSize: 15, color: 'var(--green)' }}>
                  {(trade?.tpPct || signal.tpPct) ? `+${(trade?.tpPct || signal.tpPct).toFixed(1)}%` : '-'}
                </strong>
                {(trade?.tp || signal.tp) && <span style={{ fontSize: 10, color: 'var(--muted)', display: 'block', marginTop: 2 }}>{formatUsd(trade?.tp || signal.tp)}</span>}
              </div>
              <div style={{ padding: 12, background: 'rgba(220,38,38,0.1)', borderRadius: 6, border: '1px solid rgba(220,38,38,0.2)' }}>
                <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Stop Loss</span>
                <strong style={{ fontSize: 15, color: 'var(--red)' }}>
                  {(trade?.slPct || signal.slPct) ? `-${(trade?.slPct || signal.slPct).toFixed(1)}%` : '-'}
                </strong>
                {signal.sl && <span style={{ fontSize: 10, color: 'var(--muted)', display: 'block', marginTop: 2 }}>{formatUsd(signal.sl)}</span>}
              </div>
            </div>
          </div>

          {/* Alasan Entry */}
          {ex.entryRationale?.points && ex.entryRationale.points.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <h4 style={{ fontSize: 14, margin: '0 0 12px', color: 'var(--soft)' }}>Alasan Entry</h4>
              <div style={{ padding: 16, background: 'var(--bg-secondary)', borderRadius: 8 }}>
                {ex.entryRationale.headline && (
                  <p style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 600, color: 'var(--soft)' }}>
                    {ex.entryRationale.headline}
                  </p>
                )}
                <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--soft)', lineHeight: 1.6 }}>
                  {ex.entryRationale.points.map((point, i) => (
                    <li key={i} style={{ marginBottom: 6 }}>{point}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* Exit Events */}
          {trade?.exitEvents && trade.exitEvents.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <h4 style={{ fontSize: 14, margin: '0 0 12px', color: 'var(--soft)' }}>Exit Events</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {trade.exitEvents.map((evt, i) => (
                  <div key={i} style={{
                    padding: 12,
                    background: 'var(--bg-secondary)',
                    borderRadius: 6,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 12
                  }}>
                    <span style={{ color: 'var(--soft)' }}>
                      {evt.type === 'PARTIAL_EXIT' && `${evt.tier}: exit ${(evt.size * 100).toFixed(0)}% @ ${formatUsd(evt.price)}`}
                      {evt.type === 'FULL_EXIT' && `Full exit ${(evt.size * 100).toFixed(0)}% @ ${formatUsd(evt.price)}`}
                      {evt.type === 'MOVE_STOP' && `SL → ${formatUsd(evt.newStop)}`}
                      {evt.type === 'TRAIL_STOP' && `Trail ${evt.trailPct}% → ${formatUsd(evt.newStop)}`}
                    </span>
                    {evt.pnlPct != null && (
                      <strong style={{ color: evt.pnlPct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {evt.pnlPct >= 0 ? '+' : ''}{evt.pnlPct.toFixed(1)}%
                      </strong>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Metrics */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, fontSize: 12 }}>
            <div style={{ padding: 12, background: 'var(--bg-secondary)', borderRadius: 6, textAlign: 'center' }}>
              <span style={{ color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Score</span>
              <strong style={{ fontSize: 16, color: 'var(--soft)' }}>{signal.score || '-'}</strong>
            </div>
            <div style={{ padding: 12, background: 'var(--bg-secondary)', borderRadius: 6, textAlign: 'center' }}>
              <span style={{ color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Confidence</span>
              <strong style={{ fontSize: 16, color: 'var(--soft)' }}>{signal.confidence || '-'}%</strong>
            </div>
            <div style={{ padding: 12, background: 'var(--bg-secondary)', borderRadius: 6, textAlign: 'center' }}>
              <span style={{ color: 'var(--muted)', display: 'block', marginBottom: 4 }}>R:R</span>
              <strong style={{ fontSize: 16, color: 'var(--soft)' }}>1:{signal.rr || '-'}</strong>
            </div>
          </div>

          {/* Exit Reason */}
          {trade?.exitReason && (
            <div style={{
              marginTop: 16,
              padding: 12,
              background: 'var(--bg-secondary)',
              borderRadius: 6,
              fontSize: 12,
              color: 'var(--muted)'
            }}>
              <strong style={{ color: 'var(--soft)' }}>Exit reason:</strong> {trade.exitReason}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
