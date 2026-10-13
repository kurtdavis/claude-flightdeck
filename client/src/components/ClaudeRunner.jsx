import { useState, useEffect, useRef } from 'react';
import { getProjects, getCommands, runClaude } from '../api.js';

async function getBitbucketRepos() {
  const r = await fetch('/api/bitbucket-repos');
  return r.json();
}

export default function ClaudeRunner({ selectedFile, addRun, updateRun, appendRunOutput, onRunStarted, rerunnableRun, onRerunnableConsumed, loadableTemplate, onLoadableConsumed }) {
  const [commands, setCommands] = useState([]);
  const [projects, setProjects] = useState([]);
  const [bbRepos, setBbRepos] = useState([]);
  const [bbLoading, setBbLoading] = useState(false);
  const [bbError, setBbError] = useState('');
  const [projectTab, setProjectTab] = useState('local');
  const [selectedCommand, setSelectedCommand] = useState('');
  const [autoSelected, setAutoSelected] = useState(false);
  const [cmdArgs, setCmdArgs] = useState('');
  const [cmdContext, setCmdContext] = useState('');
  const [freePrompt, setFreePrompt] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [allowPermissions, setAllowPermissions] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [launching, setLaunching] = useState(false);
  const fileInputRef = useRef(null);
  const outputRef = useRef(null);

  useEffect(() => {
    getProjects().then(setProjects).catch(() => {});
    getCommands().then(setCommands).catch(() => {});
  }, []);

  // Auto-select command when a command file is selected in FileExplorer
  useEffect(() => {
    if (!selectedFile) return;
    // Match <config>/commands/<domain>/<name>.md
    const match = selectedFile.match(/\/commands\/([^/]+)\/([^/]+)\.md$/);
    if (match) {
      const cmdId = `${match[1]}:${match[2]}`;
      setSelectedCommand(cmdId);
      setCmdArgs('');
      setCmdContext('');
      setAutoSelected(true);
    } else {
      setAutoSelected(false);
    }
  }, [selectedFile]);

  // Pre-populate form when re-running a previous run.
  // Wait for commands to load before applying a command-based run, so the
  // <select> has matching options when the value is set (avoids controlled
  // select not updating when options arrive after the value is already set).
  useEffect(() => {
    if (!rerunnableRun) return;
    const prompt = rerunnableRun.prompt || '';
    const command = rerunnableRun.command
      || (rerunnableRun.label?.startsWith('/') ? rerunnableRun.label.replace(/^\//, '') : '');
    // If command-based but commands haven't loaded yet, wait for next run of this effect
    if (command && commands.length === 0) return;
    if (command) {
      const firstLine = prompt.split('\n')[0];
      const prefix = `/${command}`;
      const derivedArgs = rerunnableRun.args !== undefined
        ? rerunnableRun.args
        : (firstLine.startsWith(prefix + ' ') ? firstLine.slice(prefix.length + 1) : '');
      const derivedContext = prompt.split('\n').slice(1).join('\n');
      setSelectedCommand(command);
      setCmdArgs(derivedArgs);
      setCmdContext(derivedContext);
    } else {
      setSelectedCommand('');
      setCmdArgs('');
      setCmdContext('');
      setFreePrompt(prompt);
    }
    setProjectPath(rerunnableRun.projectPath || '');
    setAllowPermissions(rerunnableRun.allowPermissions ?? false);
    setProjectTab('local');
    onRerunnableConsumed?.();
  }, [rerunnableRun, commands]);

  // Pre-populate form when loading a script template
  useEffect(() => {
    if (!loadableTemplate) return;
    if (loadableTemplate.command && commands.length === 0) return;
    if (loadableTemplate.command) {
      setSelectedCommand(loadableTemplate.command);
      setCmdArgs(loadableTemplate.args || '');
      setCmdContext('');
    } else {
      setSelectedCommand('');
      setCmdArgs('');
      setCmdContext('');
      setFreePrompt(loadableTemplate.freePrompt || '');
    }
    if (loadableTemplate.projectPath) {
      setProjectPath(loadableTemplate.projectPath);
      setProjectTab('local');
    }
    setAllowPermissions(loadableTemplate.allowPermissions ?? false);
    onLoadableConsumed?.();
  }, [loadableTemplate, commands]);

  const loadBbRepos = () => {
    if (bbRepos.length || bbLoading) return;
    setBbLoading(true);
    getBitbucketRepos()
      .then(data => {
        if (data?.error) { setBbError(data.error); setBbRepos([]); }
        else setBbRepos(Array.isArray(data) ? data : []);
      })
      .catch(e => setBbError(e.message))
      .finally(() => setBbLoading(false));
  };

  const readFile = (file) => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve({ name: file.name, content: e.target.result, size: file.size });
    reader.readAsText(file);
  });

  const addFiles = async (fileList) => {
    const incoming = await Promise.all(Array.from(fileList).map(readFile));
    setAttachedFiles(prev => {
      const existing = new Set(prev.map(f => f.name));
      return [...prev, ...incoming.filter(f => !existing.has(f.name))];
    });
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  const handleProjectTabChange = (tab) => {
    setProjectTab(tab);
    setProjectPath('');
    if (tab === 'bitbucket') loadBbRepos();
  };

  const effectivePrompt = selectedCommand
    ? [
        cmdArgs.trim() ? `/${selectedCommand} ${cmdArgs.trim()}` : `/${selectedCommand}`,
        cmdContext.trim()
      ].filter(Boolean).join('\n')
    : freePrompt.trim();

  const canRun = !launching && !!projectPath.trim() && !!effectivePrompt;

  const handleRun = async () => {
    if (!canRun) return;
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const label = selectedCommand ? `/${selectedCommand}` : effectivePrompt.slice(0, 60);
    const projectName = projectPath.split('/').pop();

    const run = {
      id: runId,
      label,
      command: selectedCommand,
      args: cmdArgs,
      prompt: effectivePrompt,
      projectPath,
      projectName,
      allowPermissions,
      status: 'running',
      output: [{ type: 'meta', message: `$ claude -p "${effectivePrompt}"${allowPermissions ? ' --dangerously-skip-permissions' : ''}\n  cwd: ${projectPath}` }],
      startTime: new Date().toISOString(),
      endTime: null,
      exitCode: null
    };

    addRun(run);
    setLaunching(true);
    onRunStarted?.();

    try {
      const { promise, cancel } = runClaude(projectPath, effectivePrompt, allowPermissions, runId, (data) => {
        if (data.type === 'done') {
          updateRun(runId, {
            status: data.code === 0 ? 'done' : 'error',
            exitCode: data.code,
            endTime: new Date().toISOString(),
            cancel: null,
            ...(data.sessionId && { sessionId: data.sessionId, pausedForInput: data.pausedForInput ?? false }),
          });
        } else {
          appendRunOutput(runId, data);
        }
      }, attachedFiles, selectedCommand, cmdArgs);
      updateRun(runId, { cancel });
      await promise;
    } catch (e) {
      appendRunOutput(runId, { type: 'error', message: e.message });
      updateRun(runId, { status: 'error', endTime: new Date().toISOString(), cancel: null });
    } finally {
      setLaunching(false);
    }
  };

  // Group commands by domain
  const commandsByDomain = commands.reduce((acc, cmd) => {
    (acc[cmd.domain] = acc[cmd.domain] || []).push(cmd);
    return acc;
  }, {});

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left: Controls */}
      <div style={{ width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #30363d', overflow: 'hidden' }}>
        <div style={{ flex: 1, padding: 14, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}>

          {/* Command selector */}
          <div>
            <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>
                Command
                {autoSelected && (
                  <span style={{ marginLeft: 8, fontSize: 10, color: '#3fb950', background: '#0d2f1a', padding: '1px 6px', borderRadius: 4 }}>
                    ← from explorer
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent('goto-scripts'))}
                style={{ background: 'transparent', border: 'none', color: '#484f58', fontSize: 10, cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}
                title="Browse script templates"
              >
                ⊞ Templates
              </button>
            </label>
            <select
              value={selectedCommand}
              onChange={e => { setSelectedCommand(e.target.value); setCmdArgs(''); setCmdContext(''); setAutoSelected(false); }}
              style={inputStyle}
            >
              <option value="">— Free prompt —</option>
              {Object.entries(commandsByDomain).map(([domain, cmds]) => (
                <optgroup key={domain} label={domain}>
                  {cmds.map(cmd => (
                    <option key={cmd.id} value={cmd.id}>/{cmd.id}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {/* Arguments or free prompt */}
          {selectedCommand ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={labelStyle}>Arguments</label>
              <input
                value={cmdArgs}
                onChange={e => setCmdArgs(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleRun()}
                placeholder="e.g. TIDP-421"
                style={inputStyle}
              />
              <label style={labelStyle}>Additional context <span style={{ color: '#484f58' }}>(optional)</span></label>
              <textarea
                value={cmdContext}
                onChange={e => setCmdContext(e.target.value)}
                onKeyDown={e => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && handleRun()}
                placeholder="Extra details, focus areas, constraints…"
                style={{ ...inputStyle, resize: 'vertical', minHeight: 60, fontFamily: 'inherit' }}
              />
              <div style={{ fontSize: 11, color: '#8b949e', background: '#161b22', padding: '5px 8px', borderRadius: 4, fontFamily: 'monospace', wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                {effectivePrompt}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={labelStyle}>Prompt <span style={{ color: '#484f58' }}>(⌘↵ to run)</span></label>
              <textarea
                value={freePrompt}
                onChange={e => setFreePrompt(e.target.value)}
                onKeyDown={e => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && handleRun()}
                placeholder="Describe what you need…"
                style={{ ...inputStyle, resize: 'vertical', minHeight: 80, fontFamily: 'inherit' }}
              />
            </div>
          )}

          {/* Permissions toggle */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 11, color: '#8b949e' }}>
            <input
              type="checkbox"
              checked={allowPermissions}
              onChange={e => setAllowPermissions(e.target.checked)}
              style={{ accentColor: '#1f6feb', cursor: 'pointer' }}
            />
            Allow all permissions
          </label>

          {/* File attachments */}
          <div>
            <label style={labelStyle}>
              Attach Files <span style={{ color: '#484f58' }}>(passed as readable context)</span>
            </label>
            <div
              onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: `1px dashed ${isDragging ? '#1f6feb' : '#30363d'}`,
                borderRadius: 6, padding: '8px 12px',
                background: isDragging ? '#0d1f3a' : '#0d1117',
                cursor: 'pointer', textAlign: 'center',
                color: isDragging ? '#79c0ff' : '#484f58',
                fontSize: 11, transition: 'all 0.15s'
              }}
            >
              {isDragging ? 'Drop files here' : '+ Drop files or click to attach'}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={e => { if (e.target.files.length) addFiles(e.target.files); e.target.value = ''; }}
            />
            {attachedFiles.length > 0 && (
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {attachedFiles.map((f, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#161b22', border: '1px solid #30363d', borderRadius: 4, padding: '3px 8px' }}>
                    <span style={{ fontSize: 11, color: '#79c0ff', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📄 {f.name}</span>
                    <span style={{ fontSize: 10, color: '#484f58', whiteSpace: 'nowrap' }}>{(f.size / 1024).toFixed(1)}kb</span>
                    <button
                      onClick={e => { e.stopPropagation(); setAttachedFiles(prev => prev.filter((_, j) => j !== i)); }}
                      style={{ background: 'none', border: 'none', color: '#484f58', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '0 2px' }}
                    >×</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ borderTop: '1px solid #30363d' }} />

          {/* Project selector */}
          <div>
            <label style={labelStyle}>Target Project</label>
            <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #30363d', marginBottom: 8 }}>
              {['local', 'bitbucket'].map(tab => (
                <button key={tab} onClick={() => handleProjectTabChange(tab)} style={{
                  flex: 1, padding: '5px 0', fontSize: 11, cursor: 'pointer', border: 'none',
                  background: projectTab === tab ? '#1f6feb' : '#0d1117',
                  color: projectTab === tab ? '#fff' : '#8b949e',
                  textTransform: 'capitalize'
                }}>
                  {tab === 'bitbucket' ? 'Bitbucket' : 'Local'}
                </button>
              ))}
            </div>

            {projectTab === 'local' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <select value={projectPath} onChange={e => setProjectPath(e.target.value)} style={inputStyle}>
                  <option value="">Select project…</option>
                  {projects.map(p => (
                    <option key={p.path} value={p.path}>
                      {p.hasClaudeMd ? '◈ ' : ''}{p.name}
                    </option>
                  ))}
                </select>
                <input
                  value={projectPath}
                  onChange={e => setProjectPath(e.target.value)}
                  placeholder="or enter path manually…"
                  style={inputStyle}
                />
              </div>
            )}

            {projectTab === 'bitbucket' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflow: 'auto' }}>
                {bbLoading && <div style={{ fontSize: 12, color: '#8b949e' }}>Loading repos…</div>}
                {bbError && <div style={{ fontSize: 12, color: '#f85149' }}>{bbError}</div>}
                {!bbLoading && !bbError && bbRepos.length === 0 && (
                  <div style={{ fontSize: 12, color: '#484f58' }}>No repos found</div>
                )}
                {bbRepos.map(repo => {
                  const isSelected = projectPath === (repo.localPath || '');
                  const hasLocal = !!repo.localPath;
                  return (
                    <div key={repo.slug} onClick={() => hasLocal && setProjectPath(repo.localPath)} style={{
                      padding: '7px 9px', borderRadius: 6, cursor: hasLocal ? 'pointer' : 'default',
                      background: isSelected ? '#1f4068' : '#0d1117',
                      border: `1px solid ${isSelected ? '#1f6feb' : '#30363d'}`,
                      opacity: hasLocal ? 1 : 0.5
                    }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: isSelected ? '#79c0ff' : '#e6edf3' }}>{repo.name}</div>
                      <div style={{ fontSize: 10, color: hasLocal ? '#3fb950' : '#f85149' }}>
                        {hasLocal ? `✓ ${repo.localPath}` : '✗ not cloned locally'}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {projectPath && (
              <div style={{ fontSize: 11, color: '#3fb950', background: '#0d2f1a', padding: '4px 8px', borderRadius: 4, marginTop: 6, wordBreak: 'break-all' }}>
                ✓ {projectPath}
              </div>
            )}
          </div>
        </div>

        {/* Run button */}
        <div style={{ padding: '10px 14px', borderTop: '1px solid #30363d', flexShrink: 0 }}>
          <button
            onClick={handleRun}
            disabled={!canRun}
            style={{
              width: '100%', padding: '9px 0', borderRadius: 6, border: 'none',
              background: canRun ? '#238636' : '#21262d',
              color: canRun ? '#fff' : '#484f58',
              cursor: canRun ? 'pointer' : 'default', fontSize: 13,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6
            }}
          >
            {launching
              ? <><span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>◌</span> Launching…</>
              : '▶ Run Claude'}
          </button>
        </div>
      </div>

      {/* Right: info panel */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', color: '#484f58', gap: 10, padding: 32 }}>
        <div style={{ fontSize: 32, opacity: 0.3 }}>◑</div>
        <div style={{ fontSize: 13, color: '#8b949e', textAlign: 'center', maxWidth: 280 }}>
          Configure a command and project, then click <strong style={{ color: '#e6edf3' }}>▶ Run Claude</strong>.
        </div>
        <div style={{ fontSize: 12, color: '#484f58', textAlign: 'center', maxWidth: 280 }}>
          Each run opens in the <strong style={{ color: '#8b949e' }}>◑ Runs</strong> tab where you can track concurrent executions and browse history.
        </div>
        {effectivePrompt && projectPath && (
          <div style={{ marginTop: 8, background: '#161b22', border: '1px solid #30363d', borderRadius: 6, padding: '10px 14px', fontSize: 11, fontFamily: 'monospace', color: '#8b949e', maxWidth: 340, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
            {effectivePrompt}
            {'\n'}<span style={{ color: '#484f58' }}>cwd: {projectPath}</span>
          </div>
        )}
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

const labelStyle = { fontSize: 11, color: '#8b949e', display: 'block', marginBottom: 4 };
const inputStyle = {
  width: '100%', background: '#0d1117', color: '#e6edf3',
  border: '1px solid #30363d', borderRadius: 6, padding: '7px 10px',
  fontSize: 12, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box'
};
