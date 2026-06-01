import { useState } from 'react';
import { TrendingUp, AlertTriangle, ArrowRight, Copy, Check, LineChart, Droplets, Clock } from 'lucide-react';
import { formatUsd, shortAddr } from '../data/autoTrader';

const GRADE_META = {
  'A+': { cls: 'grade-aplus', caption: 'Prioritas Tertinggi', color: 'var(--green)' },
  A: { cls: 'grade-a', caption: 'Layak Dipantau', color: 'var(--cyan)' },
  B: { cls: 'grade-b', caption: 'Selektif', color: 'var(--amber)' },
};

function gradeStyle(grade) {
  if (grade === 'A+') return { background: 'rgba(22,163,74,0.10)', color: 'var(--green)', border: '1px solid rgba(22,163,74,0.25)' };
  if (grade === 'A') return { background: 'rgba(37,99,235,0.10)', color: 'var(--cyan)', border: '1px solid rgba(37,99,235,0.25)' };
  if (grade === 'B') return { background: 'rgba(217,119,6,0.10)', color: 'var(--amber)', border: '1px solid rgba(217,119,6,0.25)' };
  return { background: 'rgba(220,38,38,0.08)', color: 'var(--red)', border: '1px solid rgba(220,38,38,0.20)' };
}

function statusChip(trade) {
  if (trade?.status === 'WIN') return { label: 'WIN', cls: 'sc-status win' };
  if (trade?.status === 'LOSS') return { label: 'LOSS', cls: 'sc-status loss' };
  if (trade?.status === 'ACTIVE') return { label: 'DILACAK', cls: 'sc-status active' };
  return { label: 'PENDING', cls: 'sc-status ready' };
}

const PHASE_STYLE = {
  new: { label: 'NEW', background: 'rgba(217,119,6,0.10)', color: 'var(--amber)', border: '1px solid rgba(217,119,6,0.25)' },
  graduating: { label: 'GRADUATING', background: 'rgba(37,99,235,0.10)', color: 'var(--cyan)', border: '1px solid rgba(37,99,235,0.25)' },
  migrated: { label: 'MIGRATED', background: 'rgba(22,163,74,0.10)', color: 'var(--green)', border: '1px solid rgba(22,163,74,0.25)' },
};

function alphaColor(score) {
  if (score >= 75) return 'var(--green)';
  if (score >= 55) return 'var(--cyan)';
  if (score >= 35) return 'var(--amber)';
  return 'var(--muted)';
}

export default function SignalCard({ signal, trade, onClick }) {
  const [copied, setCopied] = useState(false);

  // Level dikunci pakai nilai trade saat sudah entry; kalau belum, pakai sinyal.
  const entry = trade?.entry ?? signal.entry;
  const sl = trade?.sl ?? signal.sl;
  const tp = trade?.tp ?? signal.tp;
  // Persen SL/TP diturunkan dari harga aktual vs entry supaya SELALU sinkron dengan
  // angka harga — penting saat exit engine menggeser SL ke breakeven/trailing
  // (trade.sl berubah tapi trade.slPct dikunci di nilai awal → bisa berbeda).
  const slDistPct = entry && sl ? ((sl - entry) / entry) * 100
    : ((trade?.slPct ?? signal.slPct) != null ? -Math.abs(trade?.slPct ?? signal.slPct) : null);
  const tpDistPct = entry && tp ? ((tp - entry) / entry) * 100
    : ((trade?.tpPct ?? signal.tpPct) != null ? Math.abs(trade?.tpPct ?? signal.tpPct) : null);
  const livePnl = trade
    ? trade.pnlPct
    : (entry && signal.priceUsd ? ((signal.priceUsd - entry) / entry) * 100 : null);

  // Untuk posisi aktif, tampilkan grade original saat entry (bukan re-evaluasi live)
  // supaya Beranda dan Sinyal & Posisi selalu sinkron.
  const displayGrade = trade?.status === 'ACTIVE' ? trade.grade : signal.grade;
  const meta = GRADE_META[displayGrade] || { cls: '', caption: '', color: 'var(--muted)' };
  const chip = statusChip(trade);
  const isHighRisk = displayGrade === 'B';
  const chartUrl = signal.url || `https://dexscreener.com/solana/${signal.ca}`;
  const conf = Math.max(0, Math.min(100, Number(signal.confidence) || 0));

  const copyCa = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(signal.ca);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* ignore */ }
  };

  const onKey = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
  };

  return (
    <div className={`signal-card ${meta.cls}`} role="button" tabIndex={0} onClick={onClick} onKeyDown={onKey}>
      <div className="sc-head">
        <div className="sc-id">
          <strong>${signal.ticker}</strong>
          <span>{signal.name}</span>
        </div>
        <div className="sc-grade">
          <span className="badge" style={gradeStyle(displayGrade)} title={`Grade ${displayGrade} — ${meta.caption}`}>{displayGrade}</span>
          <small style={{ color: meta.color }}>{meta.caption}</small>
        </div>
      </div>

      <div className="sc-tags">
        {isHighRisk ? (
          <span className="badge" style={{ background: 'rgba(217,119,6,0.10)', color: 'var(--amber)', border: '1px solid rgba(217,119,6,0.25)' }}>
            <AlertTriangle size={12} /> SELEKTIF
          </span>
        ) : (
          <span className="badge badge-buy"><TrendingUp size={12} /> BUY</span>
        )}
        <span className={chip.cls}>{chip.label}</span>
        {(() => {
          const ph = PHASE_STYLE[signal.alpha?.phase?.key || signal.phase];
          return ph ? <span className="badge" style={{ background: ph.background, color: ph.color, border: ph.border }}>{ph.label}</span> : null;
        })()}
      </div>

      {(signal.alpha || signal.alphaScore != null) && (
        <div className="sc-alpha" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11, color: 'var(--muted)', margin: '2px 0 4px' }}>
          <span title="Meta / narasi token" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            🎯 {signal.alpha?.meta?.label || 'Tanpa meta'}
            {signal.alpha?.meta?.isFirstMover ? ' · first-mover' : signal.alpha?.meta?.isHotMeta ? ' · hot' : ''}
          </span>
          <strong style={{ color: alphaColor(Number(signal.alphaScore || 0)) }} title="Skor alpha 0-100">
            α {Number(signal.alphaScore || 0)}
          </strong>
        </div>
      )}

      {trade?.exitEvents && trade.exitEvents.length > 0 && (
        <div className="sc-tier-progress">
          {['T1','T2','T3','T4'].map((t) => {
            const hit = trade.exitEvents.some(e => e.tier === t);
            return (
              <span key={t} className={`sc-tier ${hit ? 'hit' : ''}`}>{hit ? '✓' : '○'} {t}</span>
            );
          })}
          {trade.positionRemaining > 0 && trade.positionRemaining < 1.0 && (
            <span className="sc-tier moon">🌙 {trade.positionRemaining < 0.2 ? 'EXIT' : `${(trade.positionRemaining * 100).toFixed(0)}%`}</span>
          )}
        </div>
      )}

      <div className="sc-conf" title={`Keyakinan engine ${conf}%`}>
        <div className="sc-conf-top"><span>Keyakinan</span><strong>{conf}%</strong></div>
        <div className="sc-conf-bar"><div style={{ width: `${conf}%`, background: meta.color }} /></div>
      </div>

      <div className="sc-pnl">
        <span className="sc-pnl-label">PnL Berjalan</span>
        <strong className={livePnl == null ? 'text-muted' : livePnl >= 0 ? 'text-green' : 'text-red'}>
          {livePnl == null ? '—' : `${livePnl >= 0 ? '+' : ''}${livePnl.toFixed(2)}%`}
        </strong>
        {trade && trade.positionRemaining != null && trade.positionRemaining < 1.0 && (
          <small style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
            Posisi: {(trade.positionRemaining * 100).toFixed(0)}%
          </small>
        )}
      </div>

      <div className="sc-levels">
        <div className="sc-level"><span>Harga</span><strong>{formatUsd(signal.priceUsd)}</strong></div>
        <div className="sc-level"><span>Entry</span><strong>{entry ? formatUsd(entry) : '-'}</strong></div>
        <div className="sc-level"><span>Stop Loss</span><strong className={slDistPct != null && slDistPct >= 0 ? 'text-green' : 'text-red'}>{entry && slDistPct != null ? `${slDistPct >= 0 ? '+' : ''}${slDistPct.toFixed(1)}%` : '-'}</strong></div>
        <div className="sc-level"><span>Take Profit</span><strong className="text-green">{entry && tpDistPct != null ? `+${tpDistPct.toFixed(1)}%` : '-'}</strong></div>
      </div>

      <div className="sc-meta">
        <span title="Likuiditas"><Droplets size={12} /> {formatUsd(signal.liquidityUsd)}</span>
        {signal.age && <span title="Umur token"><Clock size={12} /> {signal.age}</span>}
        {signal.rr ? <span title="Risk : Reward">RR 1:{signal.rr}</span> : null}
      </div>

      <div className="sc-foot">
        <code className="sc-ca" title={signal.ca}>{shortAddr(signal.ca)}</code>
        <div className="sc-actions">
          <button type="button" className="icon-btn" onClick={copyCa} title="Salin contract address">
            {copied ? <Check size={14} className="text-green" /> : <Copy size={14} />}
            {copied ? 'Tersalin' : 'CA'}
          </button>
          <a
            className="icon-btn chart"
            href={chartUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title="Buka chart"
          >
            <LineChart size={14} /> Chart
          </a>
          <span className="sc-open">Detail <ArrowRight size={13} /></span>
        </div>
      </div>
    </div>
  );
}
