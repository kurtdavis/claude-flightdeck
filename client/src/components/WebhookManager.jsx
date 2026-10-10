import { useState, useEffect } from 'react';
import { getProjects, getCommands } from '../api.js';

const BASE = '/api';

async function fetchWebhooks() { return (await fetch(`${BASE}/webhooks`)).json(); }
async function createWebhook(data) {
  return (await fetch(`${BASE}/webhooks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).json();
}
async function updateWebhook(id, data) {
  return (await fetch(`${BASE}/webhooks/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).json();
}
async function deleteWebhook(id) {
  return (await fetch(`${BASE}/webhooks/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } })).json();
}
async function testWebhook(id, payload) {
  return (await fetch(`${BASE}/webhooks/${id}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json();
}

const BLANK_FORM = {
  name: '', triggerKey: '', command: '', projectPath: '',
  argTemplate: '', secret: '', defaultPayload: '', allowPermissions: false, enabled: true
};

const LS_KEY = 'claude-flightdeck-test-payloads';
function loadSavedPayloads() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}
function savePayloads(map) {
  localStorage.setItem(LS_KEY, JSON.stringify(map));
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export default function WebhookManager({ onViewRuns }) {
  const [webhooks, setWebhooks] = useState([]);
  const [projects, setProjects] = useState([]);
  const [commands, setCommands] = useState([]);
  const [editingId, setEditingId] = useState(null); // null = closed, 'new' = new form, id = editing
  const [form, setForm] = useState(BLANK_FORM);
  const [testPayloads, setTestPayloads] = useState(loadSavedPayloads);
  const [testingId, setTestingId] = useState(null);
  const [saving, setSaving] = useState(false);

  const getPayload = (wh) => testPayloads[wh.id] ?? wh.defaultPayload ?? '{}';
  const setPayload = (wh, val) => {
    const next = { ...testPayloads, [wh.id]: val };
    setTestPayloads(next);
    savePayloads(next);
  };

  const load = () => fetchWebhooks().then(setWebhooks).catch(() => {});

  useEffect(() => {
    load();
    getProjects().then(setProjects).catch(() => {});
    getCommands().then(setCommands).catch(() => {});
  }, []);

  const openNew = () => { setForm(BLANK_FORM); setEditingId('new'); };
  const openEdit = (wh) => { setForm({ ...BLANK_FORM, ...wh }); setEditingId(wh.id); };
  const closeForm = () => setEditingId(null);

  const handleNameChange = (val) => {
    const wasAuto = editingId === 'new' && form.triggerKey === slugify(form.name);
    setForm(f => ({ ...f, name: val, ...(wasAuto ? { triggerKey: slugify(val) } : {}) }));
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.triggerKey.trim() || !form.command || !form.projectPath) return;
    setSaving(true);
    try {
      if (editingId === 'new') {
        await createWebhook(form);
      } else {
        await updateWebhook(editingId, form);
      }
      await load();
      closeForm();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this webhook?')) return;
    await deleteWebhook(id);
    load();
  };

  const handleToggleEnabled = async (wh) => {
    await updateWebhook(wh.id, { ...wh, enabled: !wh.enabled });
    load();
  };

  const handleTest = async (wh) => {
    let payload = {};
    try { payload = JSON.parse(getPayload(wh)); } catch {}
    setTestingId(wh.id);
    try {
      await testWebhook(wh.id, payload);
      onViewRuns?.();
    } finally {
      setTestingId(null);
    }
  };

  const commandsByDomain = commands.reduce((acc, cmd) => {
    (acc[cmd.domain] = acc[cmd.domain] || []).push(cmd);
    return acc;
  }, {});

  const origin = window.location.origin.replace(':5173', ':1337'); // vite dev proxy fix
  const webhookBaseUrl = origin;

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Webhook configs */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #30363d', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3' }}>Webhook Triggers</div>
            <div style={{ fontSize: 11, color: '#484f58', marginTop: 2 }}>Trigger Claude runs via HTTP POST — integrate with external tools and CI pipelines.</div>
          </div>
          {onViewRuns && (
            <button onClick={onViewRuns} style={{ ...btnStyle('#161b22', '#8b949e'), border: '1px solid #30363d', fontSize: 11, padding: '4px 12px' }}>
              ◑ View Runs
            </button>
          )}
          <button onClick={openNew} style={btnStyle('#238636')}>+ New Webhook</button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Add / Edit form */}
          {editingId !== null && (
            <div style={{ background: '#161b22', border: '1px solid #1f6feb', borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#79c0ff', marginBottom: 2 }}>
                {editingId === 'new' ? 'New Webhook' : 'Edit Webhook'}
              </div>

              <Field label="Name">
                <input style={inputStyle} value={form.name} onChange={e => handleNameChange(e.target.value)} placeholder="e.g. JIRA → implement-feature" />
              </Field>

              <Field label="Trigger Key" hint="Used in the webhook URL path">
                <input style={inputStyle} value={form.triggerKey} onChange={e => setForm(f => ({ ...f, triggerKey: e.target.value }))} placeholder="e.g. jira-implement-feature" />
                {form.triggerKey && (
                  <div style={{ fontSize: 10, color: '#8b949e', marginTop: 3, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                    POST {webhookBaseUrl}/webhooks/{form.triggerKey}
                  </div>
                )}
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

              <Field label="Arg Template" hint="resolved against webhook payload" tip={[
                'Reference any field in the POST JSON body using dot-notation wrapped in {{ }}.',
                '',
                '#Examples:',
                '• {{issue.key}}',
                '• {{issue.fields.summary}}',
                '• {{user.name}}',
                '',
                '#Multiple tokens are allowed:',
                '• {{issue.key}} target="{{url}}"',
                '',
                '#The resolved string is passed as arguments to the command:',
                '• /dev:implement {{issue.key}}',
              ]}>
                <input style={inputStyle} value={form.argTemplate} onChange={e => setForm(f => ({ ...f, argTemplate: e.target.value }))} placeholder="{{issue.key}}" />
                {form.argTemplate && form.command && (
                  <div style={{ fontSize: 10, color: '#8b949e', marginTop: 3, fontFamily: 'monospace' }}>
                    /{form.command} {form.argTemplate}
                  </div>
                )}
              </Field>

              <Field label="Secret" hint="Optional — sent as X-Webhook-Secret header">
                <input style={inputStyle} value={form.secret} onChange={e => setForm(f => ({ ...f, secret: e.target.value }))} placeholder="Leave blank to disable auth" type="password" />
              </Field>

              <Field label="Default Test Payload" hint="pre-fills the test payload textarea" tip={[
                'JSON body sent when this webhook is triggered.',
                'Use nested objects to match the structure your Arg Template references.',
                '',
                '#Example:',
                '• {',
                '•   "issue": {',
                '•     "key": "PROJ-123",',
                '•     "fields": {',
                '•       "summary": "Fix login bug"',
                '•     }',
                '•   },',
                '•   "user": { "name": "alice" }',
                '• }',
              ]}>
                <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 50, fontFamily: 'monospace', fontSize: 11 }} value={form.defaultPayload} onChange={e => setForm(f => ({ ...f, defaultPayload: e.target.value }))} placeholder='{"issue":{"key":"PROJ-123"}}' />
              </Field>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 11, color: '#8b949e' }}>
                <input type="checkbox" checked={form.allowPermissions} onChange={e => setForm(f => ({ ...f, allowPermissions: e.target.checked }))} style={{ accentColor: '#1f6feb' }} />
                Allow all permissions (--dangerously-skip-permissions)
              </label>

              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button onClick={handleSave} disabled={saving || !form.name || !form.triggerKey || !form.command || !form.projectPath} style={btnStyle(form.name && form.triggerKey && form.command && form.projectPath ? '#238636' : '#21262d')}>
                  {saving ? 'Saving…' : editingId === 'new' ? 'Create' : 'Save'}
                </button>
                <button onClick={closeForm} style={btnStyle('#21262d', '#8b949e')}>Cancel</button>
              </div>
            </div>
          )}

          {webhooks.length === 0 && editingId === null && (
            <div style={{ color: '#484f58', fontSize: 12, paddingTop: 8 }}>No webhooks configured. Click "+ New Webhook" to add one.</div>
          )}

          {webhooks.map(wh => (
            <div key={wh.id} style={{ background: '#161b22', border: `1px solid ${wh.enabled !== false ? '#30363d' : '#21262d'}`, borderRadius: 8, padding: 12, opacity: wh.enabled !== false ? 1 : 0.55 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3', flex: 1 }}>{wh.name}</span>
                <button onClick={() => handleToggleEnabled(wh)} title={wh.enabled !== false ? 'Disable' : 'Enable'} style={{ ...btnStyle(wh.enabled !== false ? '#0d2f1a' : '#21262d'), padding: '2px 8px', fontSize: 10, color: wh.enabled !== false ? '#3fb950' : '#484f58', border: `1px solid ${wh.enabled !== false ? '#238636' : '#30363d'}` }}>
                  {wh.enabled !== false ? '● On' : '○ Off'}
                </button>
                <button onClick={() => openEdit(wh)} style={{ ...btnStyle('#21262d'), padding: '2px 8px', fontSize: 10 }}>Edit</button>
                <button onClick={() => handleDelete(wh.id)} style={{ ...btnStyle('#21262d', '#f85149'), padding: '2px 8px', fontSize: 10 }}>Delete</button>
              </div>

              <div style={{ fontSize: 10, fontFamily: 'monospace', color: '#79c0ff', background: '#0d1117', padding: '4px 8px', borderRadius: 4, marginBottom: 6, wordBreak: 'break-all' }}>
                POST {webhookBaseUrl}/webhooks/{wh.triggerKey}
              </div>

              <div style={{ display: 'flex', gap: 12, fontSize: 10, color: '#8b949e', marginBottom: 8 }}>
                <span>/{wh.command}</span>
                {wh.argTemplate && <span style={{ color: '#d2a679' }}>{wh.argTemplate}</span>}
                <span style={{ color: '#484f58', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{wh.projectPath?.split('/').pop()}</span>
                {wh.secret && <span style={{ color: '#8b949e' }}>🔒 secret</span>}
              </div>

              {/* Test section */}
              <div style={{ borderTop: '1px solid #21262d', paddingTop: 8 }}>
                <div style={{ fontSize: 10, color: '#8b949e', marginBottom: 4, display: 'flex', alignItems: 'center' }}>
                  Test payload (JSON)
                  <InfoTip lines={[
                    'JSON body passed to this webhook on Fire Test.',
                    'Must match the structure your Arg Template references.',
                    '',
                    '#Example for {{issue.key}}:',
                    '• { "issue": { "key": "PROJ-123" } }',
                  ]} />
                </div>
                <textarea
                  value={getPayload(wh)}
                  onChange={e => setPayload(wh, e.target.value)}
                  style={{ ...inputStyle, resize: 'vertical', minHeight: 50, fontFamily: 'monospace', fontSize: 10 }}
                  placeholder='{"issue":{"key":"PROJ-123"}}'
                />
                <button
                  onClick={() => handleTest(wh)}
                  disabled={testingId === wh.id}
                  style={{ ...btnStyle('#1f4068'), marginTop: 6, padding: '4px 12px', fontSize: 11, color: '#79c0ff', border: '1px solid #1f6feb' }}
                >
                  {testingId === wh.id ? 'Firing…' : '▶ Fire Test'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function InfoTip({ lines }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-block', marginLeft: 6 }}>
      <span
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 14, height: 14, borderRadius: '50%', fontSize: 9, fontWeight: 700,
          background: '#21262d', color: '#8b949e', border: '1px solid #30363d',
          cursor: 'default', userSelect: 'none', lineHeight: 1,
        }}
      >?</span>
      {open && (
        <div style={{
          position: 'absolute', left: 20, top: -4, zIndex: 100,
          background: '#1c2128', border: '1px solid #30363d', borderRadius: 7,
          padding: '10px 12px', width: 280, boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        }}>
          {lines.map((line, i) =>
            line === '' ? <div key={i} style={{ height: 6 }} /> :
            line.startsWith('•') ? (
              <div key={i} style={{ fontSize: 10, color: '#c9d1d9', fontFamily: 'monospace', marginBottom: 3 }}>{line}</div>
            ) : (
              <div key={i} style={{ fontSize: 10, color: line.startsWith('#') ? '#8b949e' : '#e6edf3', fontWeight: line.startsWith('#') ? 400 : 500, marginBottom: 4 }}>
                {line.startsWith('#') ? line.slice(1) : line}
              </div>
            )
          )}
        </div>
      )}
    </span>
  );
}

function Field({ label, hint, tip, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 4, display: 'flex', alignItems: 'center' }}>
        <span>{label}</span>
        {hint && <span style={{ color: '#484f58', marginLeft: 6 }}>— {hint}</span>}
        {tip && <InfoTip lines={tip} />}
      </div>
      {children}
    </div>
  );
}

function btnStyle(bg, color = '#e6edf3') {
  return {
    background: bg, color, border: 'none', borderRadius: 6,
    padding: '6px 14px', fontSize: 12, cursor: 'pointer'
  };
}

const inputStyle = {
  width: '100%', background: '#0d1117', color: '#e6edf3',
  border: '1px solid #30363d', borderRadius: 6, padding: '7px 10px',
  fontSize: 12, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box'
};
