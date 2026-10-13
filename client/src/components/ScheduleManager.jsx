import { useState, useEffect, useCallback } from 'react';
import {
  getProjects, getCommands,
  getSchedules, createSchedule, updateSchedule, deleteSchedule, runScheduleNow,
  getPolls, createPoll, updatePoll, deletePoll, testPoll,
  getWorkflows,
} from '../api.js';

const INTERVAL_PRESETS = [
  { label: '5m', value: 5 },
  { label: '15m', value: 15 },
  { label: '30m', value: 30 },
  { label: '1h', value: 60 },
  { label: '6h', value: 360 },
  { label: '12h', value: 720 },
  { label: '24h', value: 1440 },
];

const BLANK_FORM = {
  sourceType: 'prompt',  // 'prompt' | 'jira' | 'bitbucket' | 'workflow'
  name: '', enabled: true, intervalMinutes: 30,
  // prompt fields
  command: '', args: '', freePrompt: '',
  // jira fields
  jqlFilter: '', maxPerRun: 5, argTemplate: '{{key}}',
  // bitbucket fields
  bbRepo: '', bbBranch: 'main',
  // workflow fields
  workflowId: '', workflowArgs: '',
  // shared
  projectPath: '', allowPermissions: false,
};

function timeAgo(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

function timeUntil(iso) {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'now';
  if (ms < 60000) return `in ${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `in ${Math.floor(ms / 60000)}m`;
  if (ms < 86400000) return `in ${Math.floor(ms / 3600000)}h`;
  return `in ${Math.floor(ms / 86400000)}d`;
}

function formatInterval(minutes) {
  if (minutes < 60) return `every ${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `every ${h}h ${m}m` : `every ${h}h`;
}

export default function ScheduleManager({ onViewRuns }) {
  const [items, setItems] = useState([]);   // merged polls + schedules
  const [projects, setProjects] = useState([]);
  const [commands, setCommands] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editingType, setEditingType] = useState(null);  // 'poll' | 'schedule' | null
  const [form, setForm] = useState(BLANK_FORM);
  const [saving, setSaving] = useState(false);
  const [actingId, setActingId] = useState(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [, setTick] = useState(0);

  const load = async () => {
    const [polls, schedules] = await Promise.all([
      getPolls().catch(() => []),
      getSchedules().catch(() => []),
    ]);
    const merged = [
      ...polls.map(p => ({ ...p, _type: 'poll' })),
      ...schedules.map(s => ({ ...s, _type: 'schedule' })),
    ].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    setItems(merged);
  };

  useEffect(() => {
    load();
    getProjects().then(setProjects).catch(() => {});
    getCommands().then(setCommands).catch(() => {});
    getWorkflows().then(setWorkflows).catch(() => {});
  }, []);

  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const setStatus = (msg) => { setStatusMsg(msg); setTimeout(() => setStatusMsg(''), 5000); };

  const openNew = () => {
    setForm(BLANK_FORM);
    setEditingId('new');
    setEditingType(null);
  };

  const openEdit = (item) => {
    const sourceType = item._type === 'poll'
      ? (item.sourceType === 'bitbucket' ? 'bitbucket' : 'jira')
      : (item.sourceType === 'workflow' ? 'workflow' : 'prompt');
    setForm({ ...BLANK_FORM, ...item, sourceType });
    setEditingId(item.id);
    setEditingType(item._type);
  };

  const closeForm = () => { setEditingId(null); setEditingType(null); };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (form.sourceType === 'jira') {
        if (!form.name || !form.jqlFilter || !form.command || !form.projectPath) return;
        const payload = {
          sourceType: 'jira',
          name: form.name, enabled: form.enabled, intervalMinutes: form.intervalMinutes,
          jqlFilter: form.jqlFilter, maxPerRun: form.maxPerRun, argTemplate: form.argTemplate,
          command: form.command, projectPath: form.projectPath, allowPermissions: form.allowPermissions,
        };
        if (editingId === 'new') await createPoll(payload);
        else await updatePoll(editingId, payload);
      } else if (form.sourceType === 'bitbucket') {
        if (!form.name || !form.bbRepo || !form.command || !form.projectPath) return;
        const payload = {
          sourceType: 'bitbucket',
          name: form.name, enabled: form.enabled, intervalMinutes: form.intervalMinutes,
          bbRepo: form.bbRepo, bbBranch: form.bbBranch || 'main',
          argTemplate: form.argTemplate,
          command: form.command, projectPath: form.projectPath, allowPermissions: form.allowPermissions,
        };
        if (editingId === 'new') await createPoll(payload);
        else await updatePoll(editingId, payload);
      } else if (form.sourceType === 'workflow') {
        if (!form.name || !form.workflowId) return;
        const payload = {
          sourceType: 'workflow',
          name: form.name, enabled: form.enabled, intervalMinutes: form.intervalMinutes,
          workflowId: form.workflowId, workflowArgs: form.workflowArgs || '',
          allowPermissions: form.allowPermissions,
        };
        if (editingId === 'new') await createSchedule(payload);
        else await updateSchedule(editingId, payload);
      } else {
        const prompt = form.command
          ? (form.args?.trim() ? `/${form.command} ${form.args.trim()}` : `/${form.command}`)
          : form.freePrompt?.trim();
        if (!form.name || !prompt || !form.projectPath) return;
        if (editingId === 'new') await createSchedule(form);
        else await updateSchedule(editingId, form);
      }
      await load();
      closeForm();
    } catch (e) {
      setStatus(`✗ ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (item) => {
    if (!confirm(`Delete "${item.name}"?`)) return;
    if (item._type === 'poll') await deletePoll(item.id);
    else await deleteSchedule(item.id);
    await load();
  };

  const handleToggle = async (item) => {
    if (item._type === 'poll') await updatePoll(item.id, { ...item, enabled: !item.enabled });
    else await updateSchedule(item.id, { ...item, enabled: !item.enabled });
    await load();
  };

  const handleRunNow = async (item) => {
    setActingId(item.id);
    setStatusMsg('');
    try {
      let result;
      if (item._type === 'poll') {
        result = await testPoll(item.id);
        if (result.error) setStatus(`✗ ${result.error}`);
        else if (result.message) setStatus(result.message);
        else { setStatus(`✓ Triggered ${result.issueCount} issue(s)`); onViewRuns?.(); }
      } else {
        result = await runScheduleNow(item.id);
        if (result.error) setStatus(`✗ ${result.error}`);
        else { setStatus('✓ Triggered'); onViewRuns?.(); }
      }
    } catch (e) {
      setStatus(`✗ ${e.message}`);
    } finally {
      setActingId(null);
    }
  };

  const commandsByDomain = commands.reduce((acc, cmd) => {
    (acc[cmd.domain] = acc[cmd.domain] || []).push(cmd);
    return acc;
  }, {});

  const effectivePrompt = form.command
    ? (form.args?.trim() ? `/${form.command} ${form.args.trim()}` : `/${form.command}`)
    : form.freePrompt?.trim();

  const canSave = !saving && !!form.name && (
    form.sourceType === 'jira'       ? !!form.projectPath && !!form.jqlFilter && !!form.command
    : form.sourceType === 'bitbucket' ? !!form.projectPath && !!form.bbRepo && !!form.command
    : form.sourceType === 'workflow'  ? !!form.workflowId
    : !!form.projectPath && !!effectivePrompt
  );

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #30363d', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3' }}>Scheduled Jobs</div>
            <div style={{ fontSize: 11, color: '#484f58', marginTop: 2 }}>Run Claude on a recurring timer. Enable JIRA mode to trigger once per matching issue.</div>
          </div>
          {statusMsg && (
            <span style={{
              fontSize: 11,
              color: statusMsg.startsWith('✓') ? '#3fb950' : '#f85149',
              background: statusMsg.startsWith('✓') ? '#0d2f1a' : '#2d1117',
              padding: '3px 10px', borderRadius: 4
            }}>
              {statusMsg}
            </span>
          )}
          {onViewRuns && (
            <button onClick={onViewRuns} style={btnStyle('#161b22', '#8b949e', '1px solid #30363d')}>
              ⚙ View Runs
            </button>
          )}
          <button onClick={openNew} style={btnStyle('#238636')}>+ New Schedule</button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>

          {/* Form */}
          {editingId !== null && (
            <div style={{ background: '#161b22', border: '1px solid #1f6feb', borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#79c0ff' }}>
                {editingId === 'new' ? 'New Schedule' : 'Edit Schedule'}
              </div>

              <Field label="Name">
                <input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Daily PR review" />
              </Field>

              <Field label="Run Interval">
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  {INTERVAL_PRESETS.map(p => (
                    <button
                      key={p.value}
                      onClick={() => setForm(f => ({ ...f, intervalMinutes: p.value }))}
                      style={{
                        padding: '4px 10px', fontSize: 11, borderRadius: 4, cursor: 'pointer', border: '1px solid',
                        background: form.intervalMinutes === p.value ? '#1f4068' : '#0d1117',
                        color: form.intervalMinutes === p.value ? '#79c0ff' : '#8b949e',
                        borderColor: form.intervalMinutes === p.value ? '#1f6feb' : '#30363d',
                      }}
                    >
                      {p.label}
                    </button>
                  ))}
                  <input
                    type="number" min="1" max="10080"
                    value={form.intervalMinutes}
                    onChange={e => setForm(f => ({ ...f, intervalMinutes: parseInt(e.target.value) || 30 }))}
                    style={{ ...inputStyle, width: 64 }}
                    title="Custom interval in minutes"
                  />
                  <span style={{ fontSize: 10, color: '#484f58' }}>min</span>
                </div>
              </Field>

              {/* Source toggles */}
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => setForm(f => ({ ...f, sourceType: f.sourceType === 'jira' ? 'prompt' : 'jira', argTemplate: '{{key}}' }))}
                  style={{
                    fontSize: 11, cursor: 'pointer', padding: '5px 12px', borderRadius: 6,
                    background: form.sourceType === 'jira' ? '#2d1a00' : '#0d1117',
                    color: form.sourceType === 'jira' ? '#d2a679' : '#484f58',
                    border: `1px solid ${form.sourceType === 'jira' ? '#6e3800' : '#30363d'}`,
                  }}
                >
                  {form.sourceType === 'jira' ? '▼ JIRA enabled' : '▶ Enable JIRA'}
                </button>
                <button
                  onClick={() => setForm(f => ({ ...f, sourceType: f.sourceType === 'bitbucket' ? 'prompt' : 'bitbucket', argTemplate: '{{shortHash}} {{message}}' }))}
                  style={{
                    fontSize: 11, cursor: 'pointer', padding: '5px 12px', borderRadius: 6,
                    background: form.sourceType === 'bitbucket' ? '#0d2a1a' : '#0d1117',
                    color: form.sourceType === 'bitbucket' ? '#3fb950' : '#484f58',
                    border: `1px solid ${form.sourceType === 'bitbucket' ? '#238636' : '#30363d'}`,
                  }}
                >
                  {form.sourceType === 'bitbucket' ? '▼ Bitbucket enabled' : '▶ Enable Bitbucket'}
                </button>
                <button
                  onClick={() => setForm(f => ({ ...f, sourceType: f.sourceType === 'workflow' ? 'prompt' : 'workflow' }))}
                  style={{
                    fontSize: 11, cursor: 'pointer', padding: '5px 12px', borderRadius: 6,
                    background: form.sourceType === 'workflow' ? '#1a2d4a' : '#0d1117',
                    color: form.sourceType === 'workflow' ? '#79c0ff' : '#484f58',
                    border: `1px solid ${form.sourceType === 'workflow' ? '#1f6feb' : '#30363d'}`,
                  }}
                >
                  {form.sourceType === 'workflow' ? '▼ Workflow enabled' : '▶ Enable Workflow'}
                </button>
              </div>

              {/* JIRA-specific fields */}
              {form.sourceType === 'jira' && (
                <>
                  <Field label="JQL Filter" hint="new matches trigger one run per issue">
                    <textarea
                      style={{ ...inputStyle, resize: 'vertical', minHeight: 56, fontFamily: 'monospace', fontSize: 11 }}
                      value={form.jqlFilter}
                      onChange={e => setForm(f => ({ ...f, jqlFilter: e.target.value }))}
                      placeholder={'project = MYPROJ AND status = "Open" ORDER BY created DESC'}
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
                </>
              )}

              {/* Bitbucket-specific fields */}
              {form.sourceType === 'bitbucket' && (
                <>
                  <Field label="Repository" hint="repo slug (e.g. my-project)">
                    <input
                      style={inputStyle}
                      value={form.bbRepo}
                      onChange={e => setForm(f => ({ ...f, bbRepo: e.target.value }))}
                      placeholder="my-project"
                    />
                  </Field>
                  <Field label="Branch" hint="branch to watch for new commits">
                    <input
                      style={inputStyle}
                      value={form.bbBranch}
                      onChange={e => setForm(f => ({ ...f, bbBranch: e.target.value }))}
                      placeholder="main"
                    />
                  </Field>
                </>
              )}

              {/* Workflow-specific fields */}
              {form.sourceType === 'workflow' && (
                <>
                  <Field label="Workflow">
                    <select
                      style={inputStyle}
                      value={form.workflowId}
                      onChange={e => setForm(f => ({ ...f, workflowId: e.target.value }))}
                    >
                      <option value="">Select workflow…</option>
                      {workflows.map(w => (
                        <option key={w.id} value={w.id}>{w.name} ({w.steps?.length ?? 0} steps)</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Initial Args" hint="optional — passed as {{input.*}} tokens in first step" tip={[
                    'Space-separated args passed to the first workflow step.',
                    '',
                    '#Example:',
                    '• PROJ-123 env=staging',
                    '',
                    '#Access in step argsOverride:',
                    '• {{input.arg0}} → PROJ-123',
                    '• {{input.env}}  → staging',
                  ]}>
                    <input
                      style={inputStyle}
                      value={form.workflowArgs}
                      onChange={e => setForm(f => ({ ...f, workflowArgs: e.target.value }))}
                      placeholder="e.g. PROJ-123 env=staging"
                    />
                  </Field>
                </>
              )}

              {form.sourceType !== 'workflow' && (
                <>
                  <Field label="Command">
                    <select
                      style={inputStyle}
                      value={form.command}
                      onChange={e => setForm(f => ({ ...f, command: e.target.value, args: '', freePrompt: '' }))}
                    >
                      {form.sourceType === 'prompt'
                        ? <option value="">— Free prompt —</option>
                        : <option value="">Select command…</option>
                      }
                      {Object.entries(commandsByDomain).map(([domain, cmds]) => (
                        <optgroup key={domain} label={domain}>
                          {cmds.map(cmd => (
                            <option key={cmd.id} value={cmd.id}>/{cmd.id}</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </Field>

                  {form.sourceType === 'bitbucket' ? (
                    <Field label="Arg Template" hint="per-commit tokens" tip={[
                      'Tokens are replaced with values from the triggering commit.',
                      '',
                      '#Available tokens:',
                      '• {{shortHash}} — e.g. a1b2c3d4',
                      '• {{hash}}      — full 40-char SHA',
                      '• {{message}}   — first line of commit message',
                      '• {{author}}    — committer display name',
                      '• {{branch}}    — branch name',
                      '• {{repo}}      — repository slug',
                      '',
                      '#Example:',
                      '• {{shortHash}} {{message}}',
                      '',
                      '#Runs as (per new commit):',
                      '• /dev:implement a1b2c3d4 Fix login bug',
                    ]}>
                      <input
                        style={inputStyle}
                        value={form.argTemplate}
                        onChange={e => setForm(f => ({ ...f, argTemplate: e.target.value }))}
                        placeholder="{{shortHash}} {{message}}"
                      />
                      {form.argTemplate && form.command && (
                        <div style={{ fontSize: 10, color: '#8b949e', marginTop: 3, fontFamily: 'monospace' }}>
                          /{form.command} {form.argTemplate}
                        </div>
                      )}
                    </Field>
                  ) : form.sourceType === 'jira' ? (
                    <Field label="Arg Template" hint="per-issue tokens" tip={[
                      'Tokens are replaced with values from each matched JIRA issue.',
                      '',
                      '#Available tokens:',
                      '• {{key}}      — e.g. PROJ-123',
                      '• {{summary}}  — issue title',
                      '• {{status}}   — e.g. Open, In Progress',
                      '• {{assignee}} — display name',
                      '• {{type}}     — e.g. Bug, Story, Task',
                      '',
                      '#Example:',
                      '• {{key}} target="My Plan"',
                      '',
                      '#Runs as (per issue):',
                      '• /dev:plan PROJ-123 target="My Plan"',
                    ]}>
                      <input
                        style={inputStyle}
                        value={form.argTemplate}
                        onChange={e => setForm(f => ({ ...f, argTemplate: e.target.value }))}
                        placeholder="{{key}}"
                      />
                      {form.argTemplate && form.command && (
                        <div style={{ fontSize: 10, color: '#8b949e', marginTop: 3, fontFamily: 'monospace' }}>
                          /{form.command} {form.argTemplate}
                        </div>
                      )}
                    </Field>
                  ) : form.command ? (
                    <Field label="Arguments" hint="passed after the command" tip={[
                      'Static text appended after the command when the schedule fires.',
                      '',
                      '#Example — command: /dev:implement',
                      '• PROJ-123 Fix login page',
                      '',
                      '#Runs as:',
                      '• /dev:implement PROJ-123 Fix login page',
                    ]}>
                      <input
                        style={inputStyle}
                        value={form.args}
                        onChange={e => setForm(f => ({ ...f, args: e.target.value }))}
                        placeholder="e.g. PROJ-123 or leave empty"
                      />
                    </Field>
                  ) : (
                    <Field label="Prompt">
                      <textarea
                        style={{ ...inputStyle, resize: 'vertical', minHeight: 72, fontFamily: 'inherit' }}
                        value={form.freePrompt}
                        onChange={e => setForm(f => ({ ...f, freePrompt: e.target.value }))}
                        placeholder="Describe what Claude should do each run…"
                      />
                    </Field>
                  )}

                  {form.sourceType !== 'jira' && effectivePrompt && (
                    <div style={{ fontSize: 11, color: '#8b949e', background: '#0d1117', padding: '5px 8px', borderRadius: 4, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                      {effectivePrompt}
                    </div>
                  )}
                </>
              )}

              {form.sourceType !== 'workflow' && (
                <Field label="Project Path">
                  <select style={inputStyle} value={form.projectPath} onChange={e => setForm(f => ({ ...f, projectPath: e.target.value }))}>
                    <option value="">Select project…</option>
                    {projects.map(p => (
                      <option key={p.path} value={p.path}>{p.hasClaudeMd ? '◈ ' : ''}{p.name}</option>
                    ))}
                  </select>
                  <input
                    style={{ ...inputStyle, marginTop: 4 }}
                    value={form.projectPath}
                    onChange={e => setForm(f => ({ ...f, projectPath: e.target.value }))}
                    placeholder="or enter path manually…"
                  />
                </Field>
              )}

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 11, color: '#8b949e' }}>
                <input
                  type="checkbox"
                  checked={form.allowPermissions}
                  onChange={e => setForm(f => ({ ...f, allowPermissions: e.target.checked }))}
                  style={{ accentColor: '#1f6feb' }}
                />
                Allow all permissions (--dangerously-skip-permissions)
              </label>

              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button onClick={handleSave} disabled={!canSave} style={btnStyle(canSave ? '#238636' : '#21262d')}>
                  {saving ? 'Saving…' : editingId === 'new' ? 'Create' : 'Save'}
                </button>
                <button onClick={closeForm} style={btnStyle('#21262d', '#8b949e')}>Cancel</button>
              </div>
            </div>
          )}

          {items.length === 0 && editingId === null && (
            <div style={{ color: '#484f58', fontSize: 12, paddingTop: 8 }}>
              No schedules configured. Click "+ New Schedule" to run Claude on a timer.
            </div>
          )}

          {items.map(item => {
            const isBitbucket = item._type === 'poll' && item.sourceType === 'bitbucket';
            const isJira = item._type === 'poll' && !isBitbucket;
            const isWorkflow = item._type === 'schedule' && item.sourceType === 'workflow';
            const wf = isWorkflow ? workflows.find(w => w.id === item.workflowId) : null;
            const displayPrompt = isBitbucket
              ? `${item.bbRepo}@${item.bbBranch || 'main'}`
              : isJira
                ? item.jqlFilter
                : isWorkflow
                  ? (wf ? `⇉ ${wf.name}` : `⇉ workflow:${item.workflowId}`)
                  : (item.command
                      ? (item.args?.trim() ? `/${item.command} ${item.args.trim()}` : `/${item.command}`)
                      : item.freePrompt || '');
            return (
              <div key={`${item._type}-${item.id}`} style={{
                background: '#161b22',
                border: `1px solid ${item.enabled !== false ? '#30363d' : '#21262d'}`,
                borderRadius: 8, padding: 12,
                opacity: item.enabled !== false ? 1 : 0.55
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3', flex: 1 }}>{item.name}</span>
                  {isBitbucket && (
                    <span style={{ fontSize: 10, background: '#0d2a1a', color: '#3fb950', border: '1px solid #238636', borderRadius: 4, padding: '1px 6px' }}>
                      Bitbucket
                    </span>
                  )}
                  {isJira && (
                    <span style={{ fontSize: 10, background: '#2d1a00', color: '#d2a679', border: '1px solid #6e3800', borderRadius: 4, padding: '1px 6px' }}>
                      JIRA
                    </span>
                  )}
                  {isWorkflow && (
                    <span style={{ fontSize: 10, background: '#1a2d4a', color: '#79c0ff', border: '1px solid #1f6feb', borderRadius: 4, padding: '1px 6px' }}>
                      Workflow
                    </span>
                  )}
                  <span style={{ fontSize: 10, color: '#8b949e', background: '#0d1117', border: '1px solid #30363d', padding: '2px 7px', borderRadius: 10 }}>
                    {formatInterval(item.intervalMinutes)}
                  </span>
                  <button
                    onClick={() => handleToggle(item)}
                    style={{
                      ...btnStyle(item.enabled !== false ? '#0d2f1a' : '#21262d', item.enabled !== false ? '#3fb950' : '#484f58'),
                      padding: '2px 8px', fontSize: 10,
                      border: `1px solid ${item.enabled !== false ? '#238636' : '#30363d'}`
                    }}
                  >
                    {item.enabled !== false ? '● On' : '○ Off'}
                  </button>
                  <button onClick={() => openEdit(item)} style={{ ...btnStyle('#21262d'), padding: '2px 8px', fontSize: 10 }}>Edit</button>
                  <button onClick={() => handleDelete(item)} style={{ ...btnStyle('#21262d', '#f85149'), padding: '2px 8px', fontSize: 10 }}>Delete</button>
                </div>

                <div style={{
                  fontSize: 11, fontFamily: 'monospace',
                  color: isBitbucket ? '#3fb950' : isJira ? '#d2a679' : isWorkflow ? '#79c0ff' : '#79c0ff',
                  background: '#0d1117', padding: '4px 8px', borderRadius: 4, marginBottom: 6,
                  wordBreak: 'break-all'
                }}>
                  {displayPrompt}
                </div>

                <div style={{ display: 'flex', gap: 12, fontSize: 10, color: '#8b949e', marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  {isJira && <span style={{ color: '#484f58' }}>max {item.maxPerRun || 5}/run</span>}
                  {isBitbucket && item.argTemplate && <span style={{ color: '#484f58', fontFamily: 'monospace' }}>{item.argTemplate}</span>}
                  {isWorkflow && item.workflowArgs && <span style={{ color: '#484f58', fontFamily: 'monospace' }}>{item.workflowArgs}</span>}
                  {!isWorkflow && <span style={{ color: '#484f58', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.projectPath?.split('/').pop()}
                  </span>}
                  <span style={{ color: '#484f58' }}>last: {timeAgo(item.lastRun)}</span>
                  <span style={{ color: item.enabled !== false ? '#8b949e' : '#484f58', marginLeft: 'auto' }}>
                    next: {item.enabled !== false ? timeUntil(item.nextRun) : 'paused'}
                  </span>
                </div>

                <div style={{ borderTop: '1px solid #21262d', paddingTop: 8 }}>
                  <button
                    onClick={() => handleRunNow(item)}
                    disabled={actingId === item.id}
                    style={{ ...btnStyle('#1f4068', '#79c0ff'), padding: '4px 12px', fontSize: 11, border: '1px solid #1f6feb' }}
                  >
                    {actingId === item.id
                      ? (isJira ? 'Querying JIRA…' : isBitbucket ? 'Checking commits…' : isWorkflow ? 'Starting workflow…' : 'Triggering…')
                      : '▶ Run Now'}
                  </button>
                </div>
              </div>
            );
          })}
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

function btnStyle(bg, color = '#e6edf3', border = 'none') {
  return { background: bg, color, border, borderRadius: 6, padding: '6px 14px', fontSize: 12, cursor: 'pointer' };
}

const inputStyle = {
  width: '100%', background: '#0d1117', color: '#e6edf3',
  border: '1px solid #30363d', borderRadius: 6, padding: '7px 10px',
  fontSize: 12, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box'
};
