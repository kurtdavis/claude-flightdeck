const BASE = '/api';

export async function getSessions() {
  const r = await fetch(`${BASE}/sessions`);
  return r.json();
}

export async function getFileTree() {
  const r = await fetch(`${BASE}/file-tree`);
  return r.json();
}

export async function getFile(filePath) {
  const r = await fetch(`${BASE}/file?path=${encodeURIComponent(filePath)}`);
  return r.json();
}

export async function saveFile(filePath, content) {
  const r = await fetch(`${BASE}/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, content })
  });
  return r.json();
}

export async function moveFile(from, to) {
  const r = await fetch(`${BASE}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to })
  });
  return r.json();
}

// Move multiple files at once into a destination folder
export async function moveFiles(paths, destFolder) {
  const moves = paths.map(from => {
    const name = from.split('/').pop();
    return { from, to: `${destFolder}/${name}` };
  });
  const r = await fetch(`${BASE}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ moves })
  });
  return r.json();
}

export async function createFolder(dirPath) {
  const r = await fetch(`${BASE}/mkdir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath })
  });
  return r.json();
}

export async function deletePath(targetPath) {
  const r = await fetch(`${BASE}/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: targetPath })
  });
  return r.json();
}

export async function getRelationships() {
  const r = await fetch(`${BASE}/relationships`);
  return r.json();
}

export async function getProjects() {
  const r = await fetch(`${BASE}/projects`);
  return r.json();
}

export async function getProjectConfig() {
  const r = await fetch(`${BASE}/project-config`);
  return r.json();
}

export async function saveProjectConfig(cfg) {
  const r = await fetch(`${BASE}/project-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  return r.json();
}

// ─── Templates ────────────────────────────────────────────────────────────────

export async function getTemplates() {
  const r = await fetch(`${BASE}/templates`);
  return r.json();
}
export async function createTemplate(data) {
  const r = await fetch(`${BASE}/templates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return r.json();
}
export async function updateTemplate(id, data) {
  const r = await fetch(`${BASE}/templates/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return r.json();
}
export async function deleteTemplate(id) {
  const r = await fetch(`${BASE}/templates/${id}`, { method: 'DELETE' });
  return r.json();
}

// ─── Workflows ────────────────────────────────────────────────────────────────

export async function getWorkflows() {
  const r = await fetch(`${BASE}/workflows`);
  return r.json();
}
export async function createWorkflow(data) {
  const r = await fetch(`${BASE}/workflows`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return r.json();
}
export async function updateWorkflow(id, data) {
  const r = await fetch(`${BASE}/workflows/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return r.json();
}
export async function deleteWorkflow(id) {
  const r = await fetch(`${BASE}/workflows/${id}`, { method: 'DELETE' });
  return r.json();
}
export async function runWorkflowNow(id, initialArgs = '') {
  const r = await fetch(`${BASE}/workflows/${id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initialArgs }) });
  return r.json();
}

// ─── Workflow runs ────────────────────────────────────────────────────────────

export async function getWorkflowRuns() {
  const r = await fetch(`${BASE}/workflow-runs`);
  return r.json();
}
export async function killWorkflowRun(execId) {
  const r = await fetch(`${BASE}/workflow-runs/${execId}`, { method: 'DELETE' });
  return r.json();
}
export async function removeWorkflowRun(execId) {
  const r = await fetch(`${BASE}/workflow-runs/${execId}/remove`, { method: 'DELETE' });
  return r.json();
}

export async function deleteProject(projectPath) {
  const r = await fetch(`${BASE}/projects`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath })
  });
  return r.json();
}

export async function getCommands() {
  const r = await fetch(`${BASE}/commands`);
  return r.json();
}

export function runClaude(projectPath, prompt, allowPermissions, runId, onData, files = [], command = '', args = '') {
  let cancel = () => {};

  const promise = fetch(`${BASE}/run-claude`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath, prompt, allowPermissions, runId, files, command, args })
  }).then(response => {
    const reader = response.body.getReader();
    cancel = () => reader.cancel();
    const decoder = new TextDecoder();
    let buffer = '';

    function pump() {
      return reader.read().then(({ done, value }) => {
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              onData(data);
            } catch {}
          }
        });
        return pump();
      }).catch(() => {}); // swallow cancellation errors
    }
    return pump();
  });

  return { promise, cancel: () => cancel() };
}

export async function getCommandRuns() {
  const r = await fetch(`${BASE}/command-runs`);
  return r.json();
}

export async function clearCommandRuns() {
  const r = await fetch(`${BASE}/command-runs`, { method: 'DELETE' });
  return r.json();
}

export async function deleteCommandRun(id) {
  const r = await fetch(`${BASE}/command-runs/${id}`, { method: 'DELETE' });
  return r.json();
}

// Reconnect to an in-progress (or finished) run and replay its output.
// Pass fromIndex to skip events the caller already has (e.g. loaded via getCommandRuns).
export function streamRun(runId, onData, fromIndex = 0) {
  let cancel = () => {};
  const url = fromIndex > 0 ? `${BASE}/run-claude/${runId}/stream?from=${fromIndex}` : `${BASE}/run-claude/${runId}/stream`;
  const promise = fetch(url).then(response => {
    const reader = response.body.getReader();
    cancel = () => reader.cancel();
    const decoder = new TextDecoder();
    let buffer = '';
    function pump() {
      return reader.read().then(({ done, value }) => {
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            try { onData(JSON.parse(line.slice(6))); } catch {}
          }
        });
        return pump();
      }).catch(() => {});
    }
    return pump();
  });
  return { promise, cancel: () => cancel() };
}

export async function killRun(runId) {
  const r = await fetch(`${BASE}/run-claude/${runId}`, { method: 'DELETE' });
  return r.json();
}

export async function sendRunInput(runId, message) {
  const r = await fetch(`${BASE}/run-claude/${runId}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
  return r.json();
}

export function continueRun(parentRunId, message, allowPermissions, onData) {
  let cancel = () => {};
  const promise = fetch(`${BASE}/run-claude/${parentRunId}/continue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, allowPermissions })
  }).then(response => {
    const reader = response.body.getReader();
    cancel = () => reader.cancel();
    const decoder = new TextDecoder();
    let buffer = '';
    function pump() {
      return reader.read().then(({ done, value }) => {
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            try { onData(JSON.parse(line.slice(6))); } catch {}
          }
        });
        return pump();
      }).catch(() => {});
    }
    return pump();
  });
  return { promise, cancel: () => cancel() };
}

export async function sendWebhookRunInput(execId, message) {
  const r = await fetch(`${BASE}/webhooks/runs/${execId}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
  return r.json();
}

export async function sendPollRunInput(execId, message) {
  const r = await fetch(`${BASE}/polls/runs/${execId}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
  return r.json();
}

export async function sendScheduleRunInput(execId, message) {
  const r = await fetch(`${BASE}/schedules/runs/${execId}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
  return r.json();
}

export async function killWebhookRun(execId) {
  const r = await fetch(`${BASE}/webhooks/runs/${execId}`, { method: 'DELETE' });
  return r.json();
}

export async function removeWebhookRun(execId) {
  const r = await fetch(`${BASE}/webhooks/runs/${execId}/remove`, { method: 'DELETE' });
  return r.json();
}

export async function removePollRun(execId) {
  const r = await fetch(`${BASE}/polls/runs/${execId}/remove`, { method: 'DELETE' });
  return r.json();
}

export async function removeScheduleRun(execId) {
  const r = await fetch(`${BASE}/schedules/runs/${execId}/remove`, { method: 'DELETE' });
  return r.json();
}

// ── Poll API
export async function getPolls() {
  const r = await fetch(`${BASE}/polls`);
  return r.json();
}

export async function createPoll(data) {
  const r = await fetch(`${BASE}/polls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return r.json();
}

export async function updatePoll(id, data) {
  const r = await fetch(`${BASE}/polls/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return r.json();
}

export async function deletePoll(id) {
  const r = await fetch(`${BASE}/polls/${id}`, { method: 'DELETE' });
  return r.json();
}

export async function testPoll(id) {
  const r = await fetch(`${BASE}/polls/${id}/test`, { method: 'POST' });
  return r.json();
}

export async function getPollRuns() {
  const r = await fetch(`${BASE}/polls/runs`);
  return r.json();
}

export async function killPollRun(execId) {
  const r = await fetch(`${BASE}/polls/runs/${execId}`, { method: 'DELETE' });
  return r.json();
}

// ── Schedule API
export async function getSchedules() {
  const r = await fetch(`${BASE}/schedules`);
  return r.json();
}

export async function createSchedule(data) {
  const r = await fetch(`${BASE}/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return r.json();
}

export async function updateSchedule(id, data) {
  const r = await fetch(`${BASE}/schedules/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return r.json();
}

export async function deleteSchedule(id) {
  const r = await fetch(`${BASE}/schedules/${id}`, { method: 'DELETE' });
  return r.json();
}

export async function runScheduleNow(id) {
  const r = await fetch(`${BASE}/schedules/${id}/run`, { method: 'POST' });
  return r.json();
}

export async function getScheduleRuns() {
  const r = await fetch(`${BASE}/schedules/runs`);
  return r.json();
}

export async function killScheduleRun(execId) {
  const r = await fetch(`${BASE}/schedules/runs/${execId}`, { method: 'DELETE' });
  return r.json();
}
