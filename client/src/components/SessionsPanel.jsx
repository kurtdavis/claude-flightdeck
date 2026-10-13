import { useState, useEffect, useCallback } from 'react';
import { getSessions } from '../api.js';

const POLL_KEY = 'flightdeck.sessionsPollSeconds';
const POLL_CHOICES = [5, 15, 30, 60];

const STATUS_COLORS = { busy: '#f0883e', idle: '#3fb950' };

function ago(ts, now) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function SessionsPanel({ onCount }) {
  const [sessions, setSessions] = useState([]);
  const [serverPoll, setServerPoll] = useState(15);
  const [minPoll, setMinPoll] = useState(5);
  const [override, setOverride] = useState(() => Number(localStorage.getItem(POLL_KEY)) || null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  const pollSeconds = Math.max(minPoll, override ?? serverPoll);

  const load = useCallback(async () => {
    try {
      const data = await getSessions();
      setSessions(data.sessions || []);
      setServerPoll(data.pollSeconds);
      setMinPoll(data.minPollSeconds);
      setError('');
      setNow(Date.now());
      onCount?.(data.sessions?.length ?? 0);
    } catch (e) {
      setError(e.message);
    }
  }, [onCount]);

  useEffect(() => {
    load();
    const id = setInterval(load, pollSeconds * 1000);
    return () => clearInterval(id);
  }, [load, pollSeconds]);

  const choices = [...new Set([...POLL_CHOICES, serverPoll])].filter(n => n >= minPoll).sort((a, b) => a - b);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0d1117' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid #30363d', flexShrink: 0 }}>
        <span style={{ fontSize: 13, color: '#e6edf3', fontWeight: 600 }}>vh-agents sessions</span>
        <span style={{ fontSize: 11, color: '#484f58' }}>{sessions.length} live</span>
        <div style={{ flex: 1 }} />
        <label style={{ fontSize: 11, color: '#8b949e' }}>
          Refresh every{' '}
          <select
            value={pollSeconds}
            onChange={e => { const n = Number(e.target.value); setOverride(n); localStorage.setItem(POLL_KEY, String(n)); }}
            style={{ background: '#21262d', color: '#e6edf3', border: '1px solid #30363d', borderRadius: 4, fontSize: 11 }}
          >
            {choices.map(n => <option key={n} value={n}>{n}s</option>)}
          </select>
        </label>
        <button onClick={load} title="Refresh now" style={{ background: '#21262d', color: '#8b949e', border: '1px solid #30363d', padding: '3px 9px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>↺</button>
      </div>
      {error && <div style={{ padding: '8px 16px', fontSize: 12, color: '#f85149' }}>Failed to load sessions: {error}</div>}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {sessions.length === 0 && !error && (
          <div style={{ padding: 24, fontSize: 12, color: '#484f58' }}>No live Claude Code sessions in vh-agents.</div>
        )}
        {sessions.map(s => (
          <div key={s.sessionId || s.pid} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid #21262d' }}>
            <span title={s.status} style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLORS[s.status] || '#484f58', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: '#e6edf3' }}>
                {s.name || s.sessionId}
                {s.agent && <span style={{ marginLeft: 8, fontSize: 10, color: '#79c0ff', background: '#1f4068', borderRadius: 4, padding: '1px 6px' }}>{s.agent}</span>}
              </div>
              <div style={{ fontSize: 11, color: '#484f58', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.cwd}</div>
            </div>
            <div style={{ fontSize: 11, color: '#8b949e', textAlign: 'right', flexShrink: 0 }}>
              <div>{s.status} · updated {ago(s.updatedAt, now)}</div>
              <div style={{ color: '#484f58' }}>pid {s.pid} · started {ago(s.startedAt, now)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
