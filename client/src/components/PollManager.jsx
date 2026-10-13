import { useState, useEffect } from 'react';
import { getProjects, getCommands, getPolls, createPoll, updatePoll, deletePoll, testPoll } from '../api.js';

const INTERVAL_PRESETS = [
  { label: '5m', value: 5 },
  { label: '15m', value: 15 },
  { label: '30m', value: 30 },
  { label: '1h', value: 60 },
  { label: '2h', value: 120 },
];

const BLANK_FORM = {
  name: '', enabled: true, intervalMinutes: 30,
  jqlFilter: '', maxPerRun: 5,
  command: '', projectPath: '',
  argTemplate: '{{key}}', allowPermissions: false
};

export default function PollManager({ onViewRuns }) {
  const [polls, setPolls] = useState([]);
  const [projects, setProjects] = useState([]);
  const [commands, setCommands] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(BLANK_FORM);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [testMsg, setTestMsg] = useState('');
  const [, setTick] = useState(0);

  const load = () => getPolls().then(setPolls).catch(() => {});

  useEffect(() => {
    load();
    getProjects().then(setProjects).catch(() => {});
    getCommands().then(setCommands).catch(() => {});
  }, []);

  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const openNew = () => { setForm(BLANK_FORM); setEditingId('new'); };
  const openEdit = (poll) => { setForm({ ...BLANK_FORM, ...poll }); setEditingId(poll.id); };
  const closeForm = () => setEditingId(null);

  const handleSave = async () => {
    if (!form.name || !form.jqlFilter || !form.command || !form.projectPath) return;
    setSaving(true);
    try {
      editingId === 'new' ? await createPoll(form) : await updatePoll(editingId, form);
      await load();
      closeForm();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this poll?')) return;
    await deletePoll(id);
    load();
  };

  const handleToggleEnabled = async (poll) => {
    await updatePoll(poll.id, { ...poll, enabled: !poll.enabled });
    load();
  };

  const handleTest = async (poll) => {
    setTestingId(poll.id);
    setTestMsg('');
    try {
      const result = await testPoll(poll.id);
      if (result.error) {
        setTestMsg(`✗ ${result.error}`);
      } else if (result.message) {
        setTestMsg(result.message);
      } else {
        setTestMsg(`✓ Triggered ${result.issueCount} issue(s)`);
        onViewRuns?.();
      }
    } catch (e) {
      setTestMsg(`✗ ${e.message}`);
    } finally {
      setTestingId(null);
      setTimeout(() => setTestMsg(''), 6000);
    }
  };

  const commandsByDomain = commands.reduce((acc, cmd) => {
    (acc[cmd.domain] = acc[cmd.domain] || []).push(cmd);
    return acc;
  }, {});

  function formatInterval(minutes) {
    if (minutes < 60) return `every ${minutes}m`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `every ${h}h ${m}m` : `every ${h}h`;
  }

  function timeAgo(isoString) {
    if (!isoString) return 'never';
    const ms = Date.now() - new Date(isoString).getTime();
    if (ms < 60000) return 'just now';
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
    return `${Math.floor(ms / 86400000)}d ago`;
  }

  function timeUntil(isoString) {
    if (!isoString) return '—';
    const ms = new Date(isoString).getTime() - Date.now();
    if (ms <= 0) return 'now';
    if (ms < 60000) return `in ${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `in ${Math.floor(ms / 60000)}m`;
    if (ms < 86400000) return `in ${Math.floor(ms / 3600000)}h`;
    return `in ${Math.floor(ms / 86400000)}d`;
  }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #30363d', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3' }}>JIRA Polls</div>
            <div style={{ fontSize: 11, color: '#484f58', marginTop: 2 }}>Periodically query Jira for new or updated issues and run Claude automatically on matches.</div>
          </div>
          {testMsg && (
            <span style={{
              fontSize: 11,
              color: testMsg.startsWith('✓') ? '#3fb950' : '#f85149',
              background: testMsg.startsWith('✓') ? '#0d2f1a' : '#2d1117',
              padding: '3px 10px', borderRadius: 4
            }}>
              {testMsg}
            </span>
          )}
          {onViewRuns && (
            <button onClick={onViewRuns} style={{ ...btnStyle('#161b22', '#8b949e'), border: '1px solid #30363d', fontSize: 11, padding: '4px 12px' }}>
              ⚙ View Runs
            </button>
          )}
          <button onClick={openNew} style={btnStyle('#238636')}>+ New Poll</button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Form */}
          {editingId !== null && (
            <div style={{ background: '#161b22', border: '1px solid #1f6feb', borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#79c0ff', marginBottom: 2 }}>
                {editingId === 'new' ? 'New Poll' : 'Edit Poll'}
              </div>

              <Field label="Name">
                <input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. New unassigned TIDP tickets" />
              </Field>

              <Field label="Check Interval">
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  {INTERVAL_PRESETS.map(p => (
                    <button
                      key={p.value}
                      onClick={() => setForm(f => ({ ...f, intervalMinutes: p.value }))}
                      style={{
                        padding: '4px 10px', fontSize: 11, borderRadius: 4, cursor: 'pointer', border: '1px solid',
                        background: form.intervalMinutes === p.value ? '#1f4068' : '#0d1117',
                        color: form.intervalMinutes === p.value ? '#79c0ff' : '#8b949e',
                        borderColor: form.intervalMinutes === p.value ? '#1f6feb' : '#30363d'
                      }}
                    >
                      {p.label}
                    </button>
                  ))}
                  <input
                    type="number" min="1" max="1440"
                    value={form.intervalMinutes}
                    onChange={e => setForm(f => ({ ...f, intervalMinutes: parseInt(e.target.value) || 30 }))}
                    style={{ ...inputStyle, width: 64 }}
                    title="Custom interval in minutes"
                  />
                  <span style={{ fontSize: 10, color: '#484f58' }}>min</span>
                </div>
              </Field>

              <Field label="JQL Filter" hint="Jira Query Language — new matches trigger a run">
                <textarea
                  style={{ ...inputStyle, resize: 'vertical', minHeight: 56, fontFamily: 'monospace', fontSize: 11 }}
                  value={form.jqlFilter}
                  onChange={e => setForm(f => ({ ...f, jqlFilter: e.target.value }))}
                  placeholder={'project = MYPROJ AND status = "Open" AND assignee is EMPTY ORDER BY created DESC'}
                />
              </Field>

              <Field label="Max Issues Per Run" hint="cap on how many new issues trigger per cycle">
                <input
                  type="number" min="1" max="20"
                  style={{ ...inputStyle, width: 70 }}
                  value={form.maxPerRun}
                  onChange={e => setForm(f => ({ ...f, maxPerRun: parseInt(e.target.value) || 5 }))}
                />
              </Field>

              <Field label="Command">
                <select style={inputStyle} value={form.command} onChange={e => setForm(f => ({ ...f, command: e.target.value }))}>
                  <option value="">Select command…</option>
                  {Object.entries(commandsByDomain).map(([domain, cmds]) => (
                    <optgroup key={domain} label={domain}>
                      {cmds.map(cmd => (
                        <option key={cmd.id} value={cmd.id}>/{cmd.id}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Field>

              <Field label="Project Path">
                <select style={inputStyle} value={form.projectPath} onChange={e => setForm(f => ({ ...f, projectPath: e.target.value }))}>
                  <option value="">Select project…</option>
                  {projects.map(p => (
                    <option key={p.path} value={p.path}>{p.hasClaudeMd ? '◈ ' : ''}{p.name}</option>
                  ))}
                </select>
                <input style={{ ...inputStyle, marginTop: 4 }} value={form.projectPath} onChange={e => setForm(f => ({ ...f, projectPath: e.target.value }))} placeholder="or enter path manually…" />
              </Field>

              <Field label="Arg Template" hint="per-issue tokens: {{key}}, {{summary}}, {{status}}, {{assignee}}, {{type}}">
                <input style={inputStyle} value={form.argTemplate} onChange={e => setForm(f => ({ ...f, argTemplate: e.target.value }))} placeholder="{{key}}" />
                {form.argTemplate && form.command && (
                  <div style={{ fontSize: 10, color: '#8b949e', marginTop: 3, fontFamily: 'monospace' }}>
                    /{form.command} {form.argTemplate}
                  </div>
                )}
              </Field>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 11, color: '#8b949e' }}>
                <input type="checkbox" checked={form.allowPermissions} onChange={e => setForm(f => ({ ...f, allowPermissions: e.target.checked }))} style={{ accentColor: '#1f6feb' }} />
                Allow all permissions (--dangerously-skip-permissions)
              </label>

              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button
                  onClick={handleSave}
                  disabled={saving || !form.name || !form.jqlFilter || !form.command || !form.projectPath}
                  style={btnStyle(form.name && form.jqlFilter && form.command && form.projectPath ? '#238636' : '#21262d')}
                >
                  {saving ? 'Saving…' : editingId === 'new' ? 'Create' : 'Save'}
                </button>
                <button onClick={closeForm} style={btnStyle('#21262d', '#8b949e')}>Cancel</button>
              </div>
            </div>
          )}

          {polls.length === 0 && editingId === null && (
            <div style={{ color: '#484f58', fontSize: 12, paddingTop: 8 }}>
              No polls configured. Click "+ New Poll" to schedule a JIRA query.
            </div>
          )}

          {polls.map(poll => (
            <div key={poll.id} style={{
              background: '#161b22',
              border: `1px solid ${poll.enabled !== false ? '#30363d' : '#21262d'}`,
              borderRadius: 8, padding: 12,
              opacity: poll.enabled !== false ? 1 : 0.55
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3', flex: 1 }}>{poll.name}</span>
                <span style={{ fontSize: 10, color: '#8b949e', background: '#0d1117', border: '1px solid #30363d', padding: '2px 7px', borderRadius: 10 }}>
                  {formatInterval(poll.intervalMinutes)}
                </span>
                <button
                  onClick={() => handleToggleEnabled(poll)}
                  style={{ ...btnStyle(poll.enabled !== false ? '#0d2f1a' : '#21262d'), padding: '2px 8px', fontSize: 10, color: poll.enabled !== false ? '#3fb950' : '#484f58', border: `1px solid ${poll.enabled !== false ? '#238636' : '#30363d'}` }}
                >
                  {poll.enabled !== false ? '● On' : '○ Off'}
                </button>
                <button onClick={() => openEdit(poll)} style={{ ...btnStyle('#21262d'), padding: '2px 8px', fontSize: 10 }}>Edit</button>
                <button onClick={() => handleDelete(poll.id)} style={{ ...btnStyle('#21262d', '#f85149'), padding: '2px 8px', fontSize: 10 }}>Delete</button>
              </div>

              <div style={{ fontSize: 10, fontFamily: 'monospace', color: '#d2a679', background: '#0d1117', padding: '4px 8px', borderRadius: 4, marginBottom: 6, wordBreak: 'break-all' }}>
                {poll.jqlFilter}
              </div>

              <div style={{ display: 'flex', gap: 12, fontSize: 10, color: '#8b949e', marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span>/{poll.command} <span style={{ color: '#79c0ff' }}>{poll.argTemplate}</span></span>
                <span style={{ color: '#484f58', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {poll.projectPath?.split('/').pop()}
                </span>
                <span style={{ color: '#484f58' }}>max {poll.maxPerRun || 5}/run</span>
                <span style={{ color: '#484f58' }}>last: {timeAgo(poll.lastRun)}</span>
                <span style={{ marginLeft: 'auto', color: poll.enabled !== false ? '#8b949e' : '#484f58' }}>
                  next: {poll.enabled !== false ? timeUntil(poll.nextRun) : 'paused'}
                </span>
              </div>

              <div style={{ borderTop: '1px solid #21262d', paddingTop: 8 }}>
                <button
                  onClick={() => handleTest(poll)}
                  disabled={testingId === poll.id}
                  style={{ ...btnStyle('#1f4068'), padding: '4px 12px', fontSize: 11, color: '#79c0ff', border: '1px solid #1f6feb' }}
                >
                  {testingId === poll.id ? 'Querying JIRA…' : '▶ Run Now'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 4 }}>
        {label}{hint && <span style={{ color: '#484f58', marginLeft: 6 }}>— {hint}</span>}
      </div>
      {children}
    </div>
  );
}

function btnStyle(bg, color = '#e6edf3') {
  return { background: bg, color, border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 12, cursor: 'pointer' };
}

const inputStyle = {
  width: '100%', background: '#0d1117', color: '#e6edf3',
  border: '1px solid #30363d', borderRadius: 6, padding: '7px 10px',
  fontSize: 12, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box'
};
