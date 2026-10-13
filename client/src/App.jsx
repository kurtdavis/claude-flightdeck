import { useState, useEffect, useCallback } from 'react';
import FileExplorer from './components/FileExplorer.jsx';
import RelationshipGraph from './components/RelationshipGraph.jsx';
import FileEditor from './components/FileEditor.jsx';
import ClaudeRunner from './components/ClaudeRunner.jsx';
import RunsPanel from './components/RunsPanel.jsx';
import WebhookManager from './components/WebhookManager.jsx';
import ScheduleManager from './components/ScheduleManager.jsx';
import AutomationRunsPanel from './components/AutomationRunsPanel.jsx';
import ProjectsManager from './components/ProjectsManager.jsx';
import ScriptsManager from './components/ScriptsManager.jsx';
import SessionsPanel from './components/SessionsPanel.jsx';
import { getFileTree, getRelationships, saveFile, moveFile, getFile, getCommandRuns, streamRun } from './api.js';

function NavItem({ icon, label, active, badge, badgeColor, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 14px', border: 'none', cursor: 'pointer',
        background: active ? 'rgba(31,111,235,0.15)' : 'transparent',
        borderRight: `2px solid ${active ? '#1f6feb' : 'transparent'}`,
        color: active ? '#79c0ff' : '#8b949e',
        fontSize: 12, textAlign: 'left',
      }}
    >
      <span style={{ fontSize: 12, width: 14, textAlign: 'center', flexShrink: 0, lineHeight: 1 }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {badge != null && (
        <span style={{
          fontSize: 10,
          background: badgeColor ?? (active ? '#1f6feb' : '#30363d'),
          color: '#fff',
          borderRadius: 10, padding: '1px 5px', minWidth: 16, textAlign: 'center'
        }}>
          {badge}
        </span>
      )}
    </button>
  );
}

function NavDivider() {
  return <div style={{ height: 1, background: '#21262d', margin: '4px 10px' }} />;
}

export default function App() {
  const [page, setPage] = useState('workspace'); // 'workspace' | 'execute'
  const [executeTab, setExecuteTab] = useState('runner');
  const [fileTree, setFileTree] = useState([]);
  const [relationships, setRelationships] = useState({ nodes: [], edges: [] });
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [runs, setRuns] = useState([]);
  const [sessionCount, setSessionCount] = useState(null);
  const [rerunnableRun, setRerunnableRun] = useState(null);
  const [loadableTemplate, setLoadableTemplate] = useState(null);

  const addRun = useCallback((run) => setRuns(prev => [run, ...prev]), []);
  const updateRun = useCallback((id, patch) => setRuns(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r)), []);
  const appendRunOutput = useCallback((id, line) => {
    setRuns(prev => prev.map(r => r.id === id
      ? { ...r, output: [...r.output, { ...line, receivedAt: Date.now() }] }
      : r));
  }, []);

  const loadTree = useCallback(async () => {
    try { setFileTree(await getFileTree()); } catch {}
  }, []);

  const loadRelationships = useCallback(async () => {
    try { setRelationships(await getRelationships()); } catch {}
  }, []);

  useEffect(() => {
    loadTree();
    loadRelationships();
    getCommandRuns().then(history => {
      if (!history?.length) return;
      setRuns(history);
      // Reconnect to any processes that were still running before the page loaded
      history.filter(r => r.status === 'running').forEach(run => {
        // Pass current output length so stream replay skips events we already have
        const { cancel } = streamRun(run.id, (data) => {
          if (data.type === 'done') {
            updateRun(run.id, {
              status: data.code === 0 ? 'done' : 'error',
              exitCode: data.code,
              endTime: new Date().toISOString(),
              cancel: null,
              ...(data.sessionId && { sessionId: data.sessionId, pausedForInput: data.pausedForInput ?? false }),
            });
          } else {
            appendRunOutput(run.id, { ...data, receivedAt: Date.now() });
          }
        }, run.output?.length ?? 0);
        updateRun(run.id, { cancel });
      });
    }).catch(() => {});
  }, []);

  // Keyboard shortcuts: Cmd/Ctrl+1 = Workspace, Cmd/Ctrl+2 = Execute
  useEffect(() => {
    const handler = (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '1') { e.preventDefault(); setPage('workspace'); }
      if (e.key === '2') { e.preventDefault(); setPage('execute'); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Navigate to Scripts tab from ClaudeRunner's "⊞ Templates" button
  useEffect(() => {
    const handler = () => { setPage('execute'); setExecuteTab('scripts'); };
    window.addEventListener('goto-scripts', handler);
    return () => window.removeEventListener('goto-scripts', handler);
  }, []);

  const handleSelectFile = useCallback(async (filePath) => {
    if (isDirty && selectedFile) {
      if (!confirm('You have unsaved changes. Discard them?')) return;
    }
    try {
      const data = await getFile(filePath);
      if (data.type === 'directory') return;
      setSelectedFile(filePath);
      setFileContent(data.content || '');
      setIsDirty(false);
      setStatusMsg('');
    } catch (e) {
      setStatusMsg(`Error opening file: ${e.message}`);
    }
  }, [isDirty, selectedFile]);

  const handleCloseEditor = useCallback(() => {
    if (isDirty && !confirm('Discard unsaved changes?')) return;
    setSelectedFile(null);
    setFileContent('');
    setIsDirty(false);
  }, [isDirty]);

  const handleSave = useCallback(async () => {
    if (!selectedFile) return;
    setIsSaving(true);
    try {
      const result = await saveFile(selectedFile, fileContent);
      setIsDirty(false);
      if (result.relationships) setRelationships(result.relationships);
      setStatusMsg('Saved');
      setTimeout(() => setStatusMsg(''), 3000);
    } catch (e) {
      setStatusMsg(`Save failed: ${e.message}`);
    } finally {
      setIsSaving(false);
    }
  }, [selectedFile, fileContent]);

  const handleMove = useCallback(async (from, to) => {
    try {
      const result = await moveFile(from, to);
      if (result.tree) setFileTree(result.tree);
      if (result.relationships) setRelationships(result.relationships);
      if (selectedFile === from) setSelectedFile(to);
      setStatusMsg('File moved');
      setTimeout(() => setStatusMsg(''), 3000);
    } catch (e) {
      setStatusMsg(`Move failed: ${e.message}`);
    }
  }, [selectedFile]);

  const handleTreeChange = useCallback((result) => {
    if (result.tree) setFileTree(result.tree);
    if (result.relationships) setRelationships(result.relationships);
    setStatusMsg('Done');
    setTimeout(() => setStatusMsg(''), 2000);
  }, []);

  const goToRunner = useCallback((filePath) => {
    if (filePath) setSelectedFile(filePath);
    setPage('execute');
    setExecuteTab('runner');
  }, []);

  const activeRunCount = runs.filter(r => r.status === 'running').length;
  const pausedRunCount = runs.filter(r => r.pausedForInput).length;

  const pageBtnStyle = (active) => ({
    padding: '4px 14px', fontSize: 12, border: 'none', cursor: 'pointer', borderRadius: 5,
    background: active ? '#1f6feb' : 'transparent',
    color: active ? '#fff' : '#8b949e',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0d1117' }}>
      {/* Top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', padding: '0 14px',
        height: 44, background: '#161b22', borderBottom: '1px solid #30363d',
        gap: 10, flexShrink: 0
      }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#e6edf3', letterSpacing: -0.3 }}>
          ◈ Claude Flightdeck
        </span>
        <span style={{ fontSize: 10, color: '#484f58', background: '#21262d', border: '1px solid #30363d', borderRadius: 4, padding: '1px 6px', letterSpacing: 0.2 }}>
          v2.0.0
        </span>

        <div style={{ width: 1, height: 18, background: '#30363d', margin: '0 2px' }} />

        {/* Page switcher */}
        <div style={{ display: 'flex', gap: 1, background: '#0d1117', borderRadius: 7, padding: 3 }}>
          <button onClick={() => setPage('workspace')} style={pageBtnStyle(page === 'workspace')}>
            Workspace
          </button>
          <button
            onClick={() => setPage('execute')}
            style={{ ...pageBtnStyle(page === 'execute'), display: 'flex', alignItems: 'center', gap: 6 }}
          >
            Execute
            {activeRunCount > 0 && (
              <span style={{ fontSize: 10, background: '#f0883e', color: '#fff', borderRadius: 8, padding: '1px 5px', lineHeight: 1.4 }}>
                {activeRunCount}
              </span>
            )}
            {pausedRunCount > 0 && (
              <span style={{ fontSize: 10, background: '#b45309', color: '#fff', borderRadius: 8, padding: '1px 5px', lineHeight: 1.4 }}>
                ⏸ {pausedRunCount}
              </span>
            )}
          </button>
        </div>

        <div style={{ flex: 1 }} />

        {statusMsg && (
          <span style={{ fontSize: 11, color: '#3fb950', background: '#0d2f1a', padding: '3px 10px', borderRadius: 4 }}>
            {statusMsg}
          </span>
        )}
        <button
          onClick={loadRelationships}
          title="Refresh graph"
          style={{ background: '#21262d', color: '#8b949e', border: '1px solid #30363d', padding: '4px 9px', borderRadius: 6, cursor: 'pointer', fontSize: 13, lineHeight: 1 }}
        >
          ↺
        </button>
      </div>

      {/* Main content */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {page === 'workspace' ? (
          <>
            {/* Explorer sidebar */}
            <div style={{
              width: 240, flexShrink: 0,
              background: '#161b22', borderRight: '1px solid #30363d',
              display: 'flex', flexDirection: 'column', overflow: 'hidden'
            }}>
              <div style={{ padding: '8px 12px 6px', fontSize: 10, color: '#484f58', textTransform: 'uppercase', letterSpacing: 0.8, borderBottom: '1px solid #30363d' }}>
                Explorer — vh-agents/.claude
              </div>
              <div style={{ flex: 1, overflow: 'auto' }}>
                <FileExplorer
                  tree={fileTree}
                  selectedFile={selectedFile}
                  onSelectFile={handleSelectFile}
                  onMoveFile={handleMove}
                  onTreeChange={handleTreeChange}
                />
              </div>
            </div>

            {/* Graph panel — shrinks when editor is open */}
            <div style={{
              flex: selectedFile ? '0 0 42%' : '1 1 0',
              minWidth: 0, position: 'relative',
              borderRight: selectedFile ? '1px solid #30363d' : 'none',
              transition: 'flex-basis 0.15s ease'
            }}>
              <RelationshipGraph
                nodes={relationships.nodes}
                edges={relationships.edges}
                selectedFile={selectedFile}
                onNodeClick={handleSelectFile}
                onRunCommand={goToRunner}
              />
            </div>

            {/* Editor panel — only when a file is selected */}
            {selectedFile && (
              <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {/* Editor header */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px',
                  background: '#161b22', borderBottom: '1px solid #30363d', flexShrink: 0
                }}>
                  <span style={{ fontSize: 11, color: '#8b949e', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {selectedFile.replace(/.*\/\.claude\//, 'vh-agents/.claude/')}
                  </span>
                  {isDirty && <span style={{ fontSize: 11, color: '#f0883e', flexShrink: 0 }}>●</span>}
                  {selectedFile.includes('/commands/') && (
                    <button
                      onClick={() => goToRunner(selectedFile)}
                      style={{ background: '#1f4068', color: '#79c0ff', border: '1px solid #1f6feb', padding: '3px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 11, flexShrink: 0 }}
                    >
                      ▶ Run
                    </button>
                  )}
                  <button
                    onClick={handleSave}
                    disabled={!isDirty || isSaving}
                    style={{
                      background: isDirty ? '#238636' : '#21262d',
                      color: isDirty ? '#fff' : '#484f58',
                      border: 'none', padding: '3px 10px', borderRadius: 5,
                      cursor: isDirty ? 'pointer' : 'default', fontSize: 11, flexShrink: 0
                    }}
                  >
                    {isSaving ? 'Saving…' : '↓ Save'}
                  </button>
                  <button
                    onClick={handleCloseEditor}
                    title="Close editor"
                    style={{ background: 'none', color: '#484f58', border: 'none', padding: '2px 5px', cursor: 'pointer', fontSize: 16, lineHeight: 1, flexShrink: 0 }}
                  >
                    ×
                  </button>
                </div>
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <FileEditor
                    filePath={selectedFile}
                    content={fileContent}
                    onChange={val => { setFileContent(val); setIsDirty(true); }}
                  />
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            {/* Execute page: nav rail */}
            <div style={{
              width: 148, flexShrink: 0,
              background: '#161b22', borderRight: '1px solid #30363d',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
              paddingTop: 6
            }}>
              <NavItem icon="▶" label="Run" active={executeTab === 'runner'} onClick={() => setExecuteTab('runner')} />
              <NavItem
                icon="◑" label="Runs" active={executeTab === 'runs'}
                badge={
                  pausedRunCount > 0 ? `⏸ ${pausedRunCount}` :
                  activeRunCount > 0 ? activeRunCount :
                  runs.length > 0 ? runs.length : null
                }
                badgeColor={pausedRunCount > 0 ? '#b45309' : activeRunCount > 0 ? '#f0883e' : undefined}
                onClick={() => setExecuteTab('runs')}
              />
              <NavItem icon="◉" label="Sessions" active={executeTab === 'sessions'} badge={sessionCount || null} badgeColor={sessionCount ? '#238636' : undefined} onClick={() => setExecuteTab('sessions')} />
              <NavItem icon="⊞" label="Scripts"active={executeTab === 'scripts'} onClick={() => setExecuteTab('scripts')} />
              <NavDivider />
              <NavItem icon="⚡" label="Webhooks" active={executeTab === 'webhooks'} onClick={() => setExecuteTab('webhooks')} />
              <NavItem icon="⏰" label="Scheduled Jobs" active={executeTab === 'schedules'} onClick={() => setExecuteTab('schedules')} />
              <NavItem icon="⚙" label="Triggered Events" active={executeTab === 'autoRuns'} onClick={() => setExecuteTab('autoRuns')} />
              <NavDivider />
              <NavItem icon="◫" label="Projects" active={executeTab === 'projects'} onClick={() => setExecuteTab('projects')} />
            </div>

            {/* Execute content */}
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {executeTab === 'runner' && (
                <ClaudeRunner
                  selectedFile={selectedFile}
                  addRun={addRun}
                  updateRun={updateRun}
                  appendRunOutput={appendRunOutput}
                  onRunStarted={() => setExecuteTab('runs')}
                  rerunnableRun={rerunnableRun}
                  onRerunnableConsumed={() => setRerunnableRun(null)}
                  loadableTemplate={loadableTemplate}
                  onLoadableConsumed={() => setLoadableTemplate(null)}
                />
              )}
              {executeTab === 'scripts' && (
                <ScriptsManager
                  addRun={addRun}
                  updateRun={updateRun}
                  appendRunOutput={appendRunOutput}
                  onRunStarted={() => setExecuteTab('runs')}
                  onViewRuns={() => setExecuteTab('autoRuns')}
                  onLoadTemplate={(tmpl) => { setLoadableTemplate(tmpl); setExecuteTab('runner'); }}
                />
              )}
              {executeTab === 'runs' && (
                <RunsPanel
                  runs={runs}
                  setRuns={setRuns}
                  updateRun={updateRun}
                  appendRunOutput={appendRunOutput}
                  onReRun={run => { setRerunnableRun(run); setExecuteTab('runner'); }}
                />
              )}
              {executeTab === 'sessions' && <SessionsPanel onCount={setSessionCount} />}
              {executeTab === 'webhooks' && (
                <WebhookManager onViewRuns={() => setExecuteTab('autoRuns')} />
              )}
              {executeTab === 'schedules' && (
                <ScheduleManager onViewRuns={() => setExecuteTab('autoRuns')} />
              )}
              {executeTab === 'autoRuns' && <AutomationRunsPanel />}
              {executeTab === 'projects' && <ProjectsManager />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
