const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const os = require('os');
const EventEmitter = require('events');

const app = express();
const PORT = 3001;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// Resolve full path to claude binary using the login shell (handles nvm, homebrew, etc.)
let CLAUDE_BIN = 'claude';
try {
  CLAUDE_BIN = execFileSync('/bin/zsh', ['-l', '-c', 'which claude'], { encoding: 'utf8' }).trim();
  console.log(`  claude → ${CLAUDE_BIN}`);
} catch {
  try {
    CLAUDE_BIN = execFileSync('/bin/bash', ['-l', '-c', 'which claude'], { encoding: 'utf8' }).trim();
    console.log(`  claude → ${CLAUDE_BIN}`);
  } catch {
    console.warn('  ⚠ could not resolve claude binary path, falling back to "claude"');
  }
}

const SKIP_DIRS = new Set([
  'cache', 'session-env', 'sessions', 'shell-snapshots', 'telemetry',
  'image-cache', 'paste-cache', 'debug', 'backups', 'downloads',
  'file-history', 'tasks', 'teams', 'plans', 'history.jsonl',
  'node_modules', '.git', 'projects', 'todos'
]);

app.use(express.json({ limit: '10mb' }));
app.use(require('cors')());

// Extract the most human-readable field from a tool's input object
function toolDetail(name, input) {
  if (!input) return '';
  const v =
    input.description ??   // Agent
    input.command ??        // Bash
    input.file_path ??      // Read, Write, Edit
    input.pattern ??        // Glob, Grep
    input.url ??            // WebFetch
    input.query ??          // WebSearch
    input.prompt ??         // Agent (fallback)
    Object.values(input)[0] ??
    '';
  // First line only, max 120 chars
  return String(v).split('\n')[0].slice(0, 120);
}

// ─── File tree ───────────────────────────────────────────────────────────────

function buildFileTree(dirPath, depth = 0) {
  if (depth > 6) return [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter(e => !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map(entry => {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          return {
            name: entry.name,
            path: fullPath,
            type: 'directory',
            children: buildFileTree(fullPath, depth + 1)
          };
        }
        return {
          name: entry.name,
          path: fullPath,
          type: 'file',
          ext: path.extname(entry.name)
        };
      });
  } catch {
    return [];
  }
}

// ─── File helpers ─────────────────────────────────────────────────────────────

function getAllFiles(dir, exts = []) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        results.push(...getAllFiles(full, exts));
      } else if (exts.length === 0 || exts.includes(path.extname(e.name))) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

function getDirectories(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
      .map(e => path.join(dir, e.name));
  } catch {
    return [];
  }
}

// ─── Relationship parser ──────────────────────────────────────────────────────

// Known agent aliases (short name used in files → actual agent file basename)
const AGENT_ALIASES = {
  'cicd-engineer': 'game-cicd-engineer',
  'workflow-architect': 'workflow-architect'
};

function parseRelationships() {
  const nodes = [];
  const edges = [];
  const entityMap = new Map(); // name/alias -> node id
  const skillPathMap = new Map(); // 'domain/skill-name' -> node id  (for skills/domain/name/ path refs)
  const sourceFiles = []; // { id, path, type } to scan for references

  const agentsDir = path.join(CLAUDE_DIR, 'agents');
  const commandsDir = path.join(CLAUDE_DIR, 'commands');
  const skillsDir = path.join(CLAUDE_DIR, 'skills');
  const settingsPath = path.join(CLAUDE_DIR, 'settings.json');

  // ── Agents
  try {
    fs.readdirSync(agentsDir)
      .filter(f => f.endsWith('.md'))
      .forEach(file => {
        const name = path.basename(file, '.md');
        const fullPath = path.join(agentsDir, file);
        const id = `agent:${name}`;
        nodes.push({ id, type: 'agent', label: name, path: fullPath });
        entityMap.set(name, id);
        sourceFiles.push({ id, path: fullPath, type: 'agent' });
      });

    // Register aliases → same node id
    Object.entries(AGENT_ALIASES).forEach(([alias, realName]) => {
      const realId = entityMap.get(realName);
      if (realId && !entityMap.has(alias)) entityMap.set(alias, realId);
    });
  } catch {}

  // ── Commands (commands/{domain}/{name}.md)
  try {
    const allCmdFiles = getAllFiles(commandsDir, ['.md']);
    allCmdFiles.forEach(filePath => {
      const name = path.basename(filePath, '.md');
      const domain = path.basename(path.dirname(filePath));
      const id = `command:${domain}:${name}`;
      nodes.push({ id, type: 'command', label: name, path: filePath, domain });
      if (!entityMap.has(name)) entityMap.set(name, id);
      entityMap.set(`${domain}/${name}`, id);
      sourceFiles.push({ id, path: filePath, type: 'command' });
    });
  } catch {}

  // ── Skills (skills/{domain}/{skill-name}/ or skills/{name}/)
  // Also handles plain .md files inside skill domain dirs
  try {
    const topDirs = getDirectories(skillsDir);
    topDirs.forEach(topDir => {
      const topName = path.basename(topDir);
      const subDirs = getDirectories(topDir);

      if (subDirs.length > 0) {
        subDirs.forEach(subDir => {
          const skillName = path.basename(subDir);
          const id = `skill:${topName}:${skillName}`;
          nodes.push({ id, type: 'skill', label: skillName, path: subDir, domain: topName });
          if (!entityMap.has(skillName)) entityMap.set(skillName, id);
          entityMap.set(`${topName}/${skillName}`, id);
          // Register path patterns: skills/domain/skill-name/
          skillPathMap.set(`${topName}/${skillName}`, id);
          skillPathMap.set(`skills/${topName}/${skillName}`, id);
        });
      }

      // Also handle .md files at top-level of domain dir (e.g. skills/bitbucket/http-api.md)
      try {
        fs.readdirSync(topDir)
          .filter(f => f.endsWith('.md'))
          .forEach(file => {
            const skillName = path.basename(file, '.md');
            const fullPath = path.join(topDir, file);
            const id = `skill:${topName}:${skillName}`;
            if (!nodes.find(n => n.id === id)) {
              nodes.push({ id, type: 'skill', label: skillName, path: fullPath, domain: topName });
              if (!entityMap.has(skillName)) entityMap.set(skillName, id);
              entityMap.set(`${topName}/${skillName}`, id);
              skillPathMap.set(`${topName}/${skillName}`, id);
              skillPathMap.set(`skills/${topName}/${skillName}`, id);
            }
          });
      } catch {}

      // Top-level skill dir with no subdirs AND no flat .md files (rare fallback)
      const hasFlatFiles = fs.readdirSync(topDir).some(f => f.endsWith('.md'));
      if (subDirs.length === 0 && !hasFlatFiles) {
        const id = `skill:${topName}`;
        if (!nodes.find(n => n.id === id)) {
          nodes.push({ id, type: 'skill', label: topName, path: topDir });
          if (!entityMap.has(topName)) entityMap.set(topName, id);
          skillPathMap.set(topName, id);
        }
      }
    });
  } catch {}


  // ── Hook scripts from ~/.claude/hooks/ directory
  const hooksDir = path.join(CLAUDE_DIR, 'hooks');
  try {
    const hookFiles = fs.readdirSync(hooksDir, { withFileTypes: true });
    hookFiles
      .filter(e => e.isFile() && !e.name.startsWith('.'))
      .forEach(entry => {
        const hookPath = path.join(hooksDir, entry.name);
        const label = entry.name.replace(/\.[^.]+$/, ''); // strip extension
        const id = `hook:file:${entry.name}`;
        if (!nodes.find(n => n.id === id)) {
          nodes.push({ id, type: 'hook', label, path: hookPath, command: entry.name, domain: 'hooks' });
        }
      });
  } catch {}

  // ── Parse references in agent and command files
  const edgeSet = new Set();

  sourceFiles.forEach(({ id: sourceId, path: filePath }) => {
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf8'); } catch { return; }

    // 1. Explicit skills/domain/skill-name/ path references → uses edge
    const skillPathRefs = content.match(/skills\/[\w-]+\/[\w-]+\/?/g) || [];
    skillPathRefs.forEach(ref => {
      const key = ref.replace(/^skills\//, '').replace(/\/$/, ''); // domain/skill-name
      const targetId = skillPathMap.get(`skills/${key}`) || skillPathMap.get(key);
      if (targetId && targetId !== sourceId) addEdge(edges, edgeSet, sourceId, targetId, 'uses', false);
    });

    // 2. "Spawn `agent-name`" or "Spawn agent-name" patterns → spawns edge (animated)
    const spawnRefs = content.match(/[Ss]pawn\s+`?([a-z][\w-]+)`?/g) || [];
    spawnRefs.forEach(ref => {
      const name = ref.replace(/[Ss]pawn\s+`?/, '').replace(/`$/, '').trim();
      if (entityMap.has(name)) {
        const targetId = entityMap.get(name);
        if (targetId !== sourceId) addEdge(edges, edgeSet, sourceId, targetId, 'spawns', true);
      }
    });

    // 3. Backtick references to other agents (not already caught by spawn) → spawns edge
    const backtickRefs = content.match(/`([a-z][\w-]+-(?:director|agent|architect|engineer|designer|writer|builder|publisher|manager|frontend|backend|networking))`/g) || [];
    backtickRefs.forEach(match => {
      const name = match.slice(1, -1).trim();
      if (entityMap.has(name)) {
        const targetId = entityMap.get(name);
        if (targetId !== sourceId && targetId.startsWith('agent:')) {
          addEdge(edges, edgeSet, sourceId, targetId, 'spawns', true);
        }
      }
    });

    // 4. "Skills: name1, name2" inline list from command invocation blocks → uses edges
    const skillsInvoke = content.match(/Skills:\s+([^\n]+)/g) || [];
    skillsInvoke.forEach(line => {
      const names = line.replace(/Skills:\s+/, '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
      names.forEach(name => {
        if (entityMap.has(name)) {
          const targetId = entityMap.get(name);
          if (targetId !== sourceId && targetId.startsWith('skill:')) {
            addEdge(edges, edgeSet, sourceId, targetId, 'uses', false);
          }
        }
      });
    });

    // 5. Bare skill name references (short name only, require exact match in entityMap)
    //    Only match known skill names that don't conflict with common words
    entityMap.forEach((targetId, name) => {
      if (targetId === sourceId || name.length < 5) return;
      if (!targetId.startsWith('skill:')) return;
      // Already covered by path refs above? skip if so
      if (edgeSet.has(`${sourceId}-->${targetId}`)) return;
      // Require the name to appear in a relevant context (after colon, in backticks, after "load")
      const contextRegex = new RegExp(`(?:skills?:|Load|load|use|Use)\\s*[:\\s]*\`?\\b${name}\\b\`?`, 'i');
      if (contextRegex.test(content)) {
        addEdge(edges, edgeSet, sourceId, targetId, 'uses', false);
      }
    });
  });

  // ── External service nodes + edges ────────────────────────────────────────
  // Services derived from mcpServers in settings.json
  const SERVICE_DEFS = {
    jira:       { label: 'Jira',       icon: 'J', keywords: ['Jira REST API', 'jira REST API', 'list_jira_projects', 'read_jira_issue', 'create_jira_issue'] },
    confluence: { label: 'Confluence', icon: 'C', keywords: ['Confluence REST API', 'confluence REST API', 'read_confluence_page', 'create_confluence_page', 'update_confluence_page', 'Confluence API'] },
    bitbucket:  { label: 'Bitbucket', icon: 'B', keywords: ['mcp__bitbucket', 'Bitbucket MCP', 'bitbucket MCP', 'Bitbucket REST API', 'BITBUCKET_TOKEN', 'api.bitbucket.org'] },
    github:     { label: 'GitHub',    icon: 'G', keywords: ['mcp__github', 'GitHub MCP', 'github MCP'] }
  };

  // Which agent/command names map to which services (by name prefix + domain)
  const NAME_TO_SERVICES = {
    'jira-agent':           ['jira'],
    'jira-director':        ['jira', 'confluence'],  // jira-director reads Jira, sometimes fetches Confluence
    'confluence-publisher': ['confluence'],
    'confluence-content-writer': ['confluence'],
    'confluence-diagram-builder': ['confluence'],
    'confluence-director':  ['confluence'],
    'confluence-template-manager': ['confluence'],
    'bitbucket-agent':      ['bitbucket'],
    'bitbucket-director':   ['bitbucket']
  };

  // Command domain → service
  const DOMAIN_TO_SERVICES = {
    jira:       ['jira'],
    confluence: ['confluence'],
    bitbucket:  ['bitbucket']
  };

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const mcpServers = settings.mcpServers || {};
    const enabledServices = new Set();

    // Determine which services are configured (MCP or env-var based)
    const envVars = settings.env || {};
    if (mcpServers.atlassian || envVars.ATLASSIAN_API_TOKEN) { enabledServices.add('jira'); enabledServices.add('confluence'); }
    if (mcpServers.bitbucket || envVars.BITBUCKET_TOKEN) enabledServices.add('bitbucket');
    if (mcpServers.github || envVars.GITHUB_PERSONAL_ACCESS_TOKEN || envVars.GITHUB_TOKEN) enabledServices.add('github');

    // Create service nodes
    enabledServices.forEach(svcKey => {
      const def = SERVICE_DEFS[svcKey];
      const id = `service:${svcKey}`;
      nodes.push({ id, type: 'service', service: svcKey, label: def.label, icon: def.icon, path: settingsPath });
    });

    // Create edges: agents/commands → services they access
    const svcEdgeSet = new Set();

    sourceFiles.forEach(({ id: sourceId, path: filePath, type: srcType }) => {
      let content = '';
      try { content = fs.readFileSync(filePath, 'utf8'); } catch { return; }

      const agentOrCmdName = path.basename(filePath, '.md');
      const domain = srcType === 'command' ? path.basename(path.dirname(filePath)) : null;

      enabledServices.forEach(svcKey => {
        const def = SERVICE_DEFS[svcKey];
        const svcId = `service:${svcKey}`;

        // 1. Name-based match
        const nameMatch = NAME_TO_SERVICES[agentOrCmdName]?.includes(svcKey);
        // 2. Domain-based match (commands)
        const domainMatch = domain && DOMAIN_TO_SERVICES[domain]?.includes(svcKey);
        // 3. Content keyword match
        const contentMatch = def.keywords.some(kw => content.includes(kw));

        if ((nameMatch || domainMatch || contentMatch) && !svcEdgeSet.has(`${sourceId}-->${svcId}`)) {
          svcEdgeSet.add(`${sourceId}-->${svcId}`);
          edges.push({ id: `${sourceId}-->${svcId}`, source: sourceId, target: svcId, label: 'accesses', type: 'smoothstep', animated: false });
        }
      });
    });
  } catch {}

  return { nodes, edges };
}

function addEdge(edges, edgeSet, source, target, label, animated = false) {
  const key = `${source}-->${target}`;
  if (!edgeSet.has(key)) {
    edgeSet.add(key);
    edges.push({ id: key, source, target, label, type: 'smoothstep', animated });
  }
}

// ─── API Routes ───────────────────────────────────────────────────────────────

app.get('/api/file-tree', (_req, res) => {
  res.json(buildFileTree(CLAUDE_DIR));
});

app.get('/api/file', async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath || !filePath.startsWith(os.homedir())) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      return res.json({ type: 'directory', files: fs.readdirSync(filePath) });
    }
    const content = await fsp.readFile(filePath, 'utf8');
    res.json({ content, path: filePath });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.put('/api/file', async (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath || !filePath.startsWith(os.homedir())) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    await fsp.writeFile(filePath, content, 'utf8');
    const relationships = parseRelationships();
    res.json({ success: true, relationships });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/move', async (req, res) => {
  try {
    // Supports batch: { moves: [{from, to}] } or single: { from, to }
    const moves = req.body.moves || [{ from: req.body.from, to: req.body.to }];
    for (const { from, to } of moves) {
      if (!from?.startsWith(os.homedir()) || !to?.startsWith(os.homedir())) {
        return res.status(400).json({ error: `Invalid path: ${from} → ${to}` });
      }
      await fsp.rename(from, to);
    }
    res.json({ success: true, tree: buildFileTree(CLAUDE_DIR), relationships: parseRelationships() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/mkdir', async (req, res) => {
  try {
    const { path: dirPath } = req.body;
    if (!dirPath?.startsWith(os.homedir())) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    await fsp.mkdir(dirPath, { recursive: true });
    res.json({ success: true, tree: buildFileTree(CLAUDE_DIR) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/delete', async (req, res) => {
  try {
    const { path: targetPath } = req.body;
    if (!targetPath?.startsWith(os.homedir())) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    // Safety: never delete the root claude dir itself
    if (targetPath === CLAUDE_DIR) {
      return res.status(400).json({ error: 'Cannot delete root claude directory' });
    }
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    } else {
      await fsp.unlink(targetPath);
    }
    res.json({ success: true, tree: buildFileTree(CLAUDE_DIR), relationships: parseRelationships() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/relationships', (_req, res) => {
  try {
    res.json(parseRelationships());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Returns configured MCP services with metadata
app.get('/api/services', (_req, res) => {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8'));
    const mcpServers = settings.mcpServers || {};
    const services = [];

    if (mcpServers.atlassian) {
      const env = mcpServers.atlassian.env || {};
      services.push({ key: 'jira',       label: 'Jira',       baseUrl: env.ATLASSIAN_BASE_URL, email: env.ATLASSIAN_EMAIL });
      services.push({ key: 'confluence', label: 'Confluence', baseUrl: env.ATLASSIAN_BASE_URL, email: env.ATLASSIAN_EMAIL });
    }
    if (mcpServers.bitbucket) {
      const args = mcpServers.bitbucket.args || [];
      const wsIdx = args.indexOf('--default-workspace');
      services.push({ key: 'bitbucket', label: 'Bitbucket', workspace: wsIdx >= 0 ? args[wsIdx + 1] : 'unknown' });
    }
    if (mcpServers.github) {
      services.push({ key: 'github', label: 'GitHub' });
    }
    res.json(services);
  } catch (e) {
    res.json([]);
  }
});

// Lists Bitbucket repos from the configured workspace
app.get('/api/bitbucket-repos', async (_req, res) => {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8'));
    const bbConfig = settings.mcpServers?.bitbucket;
    if (!bbConfig) return res.json([]);

    const args = bbConfig.args || [];
    const tokenIdx = args.indexOf('--bitbucket-token');
    const wsIdx    = args.indexOf('--default-workspace');
    const token     = tokenIdx >= 0 ? args[tokenIdx + 1] : null;
    const workspace = wsIdx    >= 0 ? args[wsIdx    + 1] : null;

    if (!token) return res.json({ error: 'No Bitbucket token configured' });
    if (!workspace) return res.json({ error: 'No Bitbucket workspace configured' });

    const resp = await fetch(
      `https://api.bitbucket.org/2.0/repositories/${workspace}?pagelen=50&sort=-updated_on`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );

    if (!resp.ok) return res.status(resp.status).json({ error: `Bitbucket API error: ${resp.status}` });

    const data = await resp.json();
    const repos = (data.values || []).map(r => ({
      name:      r.name,
      slug:      r.slug,
      workspace,
      fullName:  r.full_name,
      language:  r.language || '',
      isPrivate: r.is_private,
      cloneUrl:  r.links?.clone?.find(c => c.name === 'https')?.href || '',
      sshUrl:    r.links?.clone?.find(c => c.name === 'ssh')?.href   || '',
      webUrl:    r.links?.html?.href || '',
      updatedOn: r.updated_on,
      description: r.description || ''
    }));

    // Check if each repo is cloned locally in common locations
    const searchBases = [
      path.join(os.homedir(), 'Documents/Repos'),
      path.join(os.homedir(), 'Projects'),
      path.join(os.homedir(), 'code')
    ];
    repos.forEach(repo => {
      repo.localPath = null;
      for (const base of searchBases) {
        const candidate = path.join(base, repo.slug);
        if (fs.existsSync(candidate)) { repo.localPath = candidate; break; }
        const candidate2 = path.join(base, repo.name);
        if (fs.existsSync(candidate2)) { repo.localPath = candidate2; break; }
      }
    });

    res.json(repos);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Project config persistence (custom paths) ───────────────────────────────

const PROJECT_CONFIG_FILE = path.join(__dirname, 'project-config.json');

function loadProjectConfig() {
  try { return JSON.parse(fs.readFileSync(PROJECT_CONFIG_FILE, 'utf8')); } catch { return { customPaths: [] }; }
}

function saveProjectConfig(cfg) {
  try { fs.writeFileSync(PROJECT_CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch {}
}

app.get('/api/project-config', (_req, res) => res.json(loadProjectConfig()));

app.post('/api/project-config', (req, res) => {
  const cfg = loadProjectConfig();
  const { customPaths } = req.body;
  if (Array.isArray(customPaths)) cfg.customPaths = customPaths.filter(p => typeof p === 'string' && p.trim());
  saveProjectConfig(cfg);
  res.json(cfg);
});

app.get('/api/projects', (_req, res) => {
  const defaultBases = [
    path.join(os.homedir(), 'Documents/Repos'),
    path.join(os.homedir(), 'Projects'),
    path.join(os.homedir(), 'code'),
    path.join(os.homedir(), 'dev'),
    os.homedir()
  ];
  const { customPaths = [] } = loadProjectConfig();
  const searchBases = [...defaultBases, ...customPaths];
  const projects = [];
  const seen = new Set();
  searchBases.forEach((base, idx) => {
    const isCustom = idx >= defaultBases.length;
    try {
      // Custom paths can be added as direct project directories or parent directories
      const stat = fs.statSync(base);
      if (isCustom && stat.isDirectory() && fs.existsSync(path.join(base, 'CLAUDE.md'))) {
        // Treat the custom path itself as a project if it has CLAUDE.md
        if (!seen.has(base)) {
          seen.add(base);
          projects.push({ name: path.basename(base), path: base, hasClaudeMd: true, custom: true });
        }
        return;
      }
    } catch {}
    try {
      fs.readdirSync(base, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .forEach(e => {
          const p = path.join(base, e.name);
          if (!seen.has(p)) {
            seen.add(p);
            const hasClaudeMd = fs.existsSync(path.join(p, 'CLAUDE.md'));
            projects.push({ name: e.name, path: p, hasClaudeMd });
          }
        });
    } catch {}
  });
  res.json(projects);
});

// Clean-delete a project: remove associated webhooks, polls, schedules, and command runs
app.delete('/api/projects', (req, res) => {
  const { projectPath } = req.body;
  if (!projectPath || typeof projectPath !== 'string') {
    return res.status(400).json({ error: 'projectPath required' });
  }

  const removed = { webhooks: 0, polls: 0, schedules: 0, runs: 0 };

  // Remove webhooks tied to this project
  const webhooks = loadWebhooks();
  const filteredWebhooks = webhooks.filter(w => w.projectPath !== projectPath);
  removed.webhooks = webhooks.length - filteredWebhooks.length;
  saveWebhooks(filteredWebhooks);

  // Remove polls tied to this project
  const polls = loadPolls();
  const filteredPolls = polls.filter(p => p.projectPath !== projectPath);
  removed.polls = polls.length - filteredPolls.length;
  savePolls(filteredPolls);

  // Remove schedules tied to this project
  const schedules = loadSchedules();
  const filteredSchedules = schedules.filter(s => s.projectPath !== projectPath);
  removed.schedules = schedules.length - filteredSchedules.length;
  saveSchedules(filteredSchedules);

  // Remove command runs tied to this project
  const before = commandRunsStore.length;
  commandRunsStore.splice(0, commandRunsStore.length, ...commandRunsStore.filter(r => r.projectPath !== projectPath));
  removed.runs = before - commandRunsStore.length;
  saveCommandRuns();

  // Delete the project directory from the filesystem
  try {
    fs.rmSync(projectPath, { recursive: true, force: true });
  } catch (e) {
    return res.status(500).json({ error: `Cleaned automation data but failed to delete folder: ${e.message}`, removed });
  }

  res.json({ ok: true, removed });
});

app.get('/api/commands', (_req, res) => {
  const commandsDir = path.join(CLAUDE_DIR, 'commands');
  const commands = [];
  try {
    const domains = fs.readdirSync(commandsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name));
    domains.forEach(domain => {
      try {
        fs.readdirSync(path.join(commandsDir, domain.name))
          .filter(f => f.endsWith('.md'))
          .forEach(file => {
            const name = path.basename(file, '.md');
            commands.push({ id: `${domain.name}:${name}`, domain: domain.name, name });
          });
      } catch {}
    });
  } catch {}
  res.json(commands);
});

// runId → child process; allows sending stdin feedback to non-permissive runs
const claudeProcs = new Map();
// runId → EventEmitter; allows multiple SSE clients to subscribe to the same run
const runEmitters = new Map();

// ─── Command run persistence ──────────────────────────────────────────────────

const COMMAND_RUNS_FILE = path.join(__dirname, 'command-runs.json');
const MAX_COMMAND_RUNS = 100;

function loadCommandRuns() {
  try {
    const runs = JSON.parse(fs.readFileSync(COMMAND_RUNS_FILE, 'utf8'));
    // Mark any in-flight runs as interrupted (server restarted mid-run)
    return runs.map(r => r.status === 'running'
      ? { ...r, status: 'interrupted', endTime: new Date().toISOString() }
      : r);
  } catch { return []; }
}

function saveCommandRuns() {
  try { fs.writeFileSync(COMMAND_RUNS_FILE, JSON.stringify(commandRunsStore, null, 2)); } catch {}
}

const commandRunsStore = loadCommandRuns();

app.post('/api/run-claude', (req, res) => {
  const { projectPath, prompt: rawPrompt, allowPermissions, runId, files, command: runCommand, args: runArgs } = req.body;

  // Write any attached files to a temp dir and append their paths to the prompt
  let prompt = rawPrompt;
  let uploadDir = null;
  if (Array.isArray(files) && files.length > 0) {
    uploadDir = path.join(os.tmpdir(), `claude-uploads-${runId || Date.now()}`);
    fs.mkdirSync(uploadDir, { recursive: true });
    const filePaths = [];
    for (const f of files) {
      const safeName = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(uploadDir, safeName);
      fs.writeFileSync(filePath, f.content);
      filePaths.push(filePath);
    }
    prompt = prompt + `\n\n---\nAttached files (read as needed):\n${filePaths.map(p => `- ${p}`).join('\n')}`;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Build a persistent record for this run
  const recId = runId || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const runRecord = {
    id: recId,
    label: rawPrompt.split('\n')[0].slice(0, 80),
    command: runCommand || '',
    args: runArgs || '',
    prompt: rawPrompt,
    projectPath,
    projectName: path.basename(projectPath),
    allowPermissions: allowPermissions !== false,
    status: 'running',
    output: [],
    startTime: new Date().toISOString(),
    endTime: null,
    exitCode: null
  };
  commandRunsStore.unshift(runRecord);
  if (commandRunsStore.length > MAX_COMMAND_RUNS) commandRunsStore.pop();

  // One emitter per run — decouples the process from any single SSE connection
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);
  runEmitters.set(recId, emitter);

  // send() buffers output AND broadcasts to all subscribed SSE listeners
  const send = (data) => {
    if (data.type !== 'start') runRecord.output.push(data);
    emitter.emit('data', data);
  };

  // Wire the initial SSE response to the emitter
  const onInitialData = (data) => {
    if (!res.writableEnded) {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
    }
  };
  emitter.on('data', onInitialData);

  // Kick off with a start event (not buffered)
  try { res.write(`data: ${JSON.stringify({ type: 'start', message: `Running in ${projectPath}` })}\n\n`); } catch {}


  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  if (allowPermissions) args.push('--dangerously-skip-permissions');

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: projectPath,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (runId) claudeProcs.set(runId, proc);

  let stdoutBuf = '';
  proc.stdout.on('data', d => {
    stdoutBuf += d.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop(); // keep incomplete line in buffer
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'assistant') {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'text' && block.text) {
              send({ type: 'output', message: block.text });
            } else if (block.type === 'tool_use') {
              if (block.name === 'AskUserQuestion') {
                send({ type: 'ask_user', message: block.input?.question ?? '', options: block.input?.options ?? [] });
              } else {
                send({ type: 'tool', message: `⚙ ${block.name}`, detail: toolDetail(block.name, block.input) });
              }
            }
          }
        } else if (event.type === 'user') {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'tool_result') {
              const content = Array.isArray(block.content)
                ? block.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
                : String(block.content ?? '');
              if (content) send({ type: 'tool_result', message: content.slice(0, 500) });
            }
          }
        } else if (event.type === 'result') {
          if (event.is_error) send({ type: 'error', message: event.result ?? 'Unknown error' });
          if (event.session_id) runRecord.sessionId = event.session_id;
        }
      } catch {
        send({ type: 'output', message: line });
      }
    }
  });
  proc.stderr.on('data', d => send({ type: 'error', message: d.toString() }));
  proc.on('close', (code, signal) => {
    claudeProcs.delete(recId);
    if (runId) claudeProcs.delete(runId);
    if (uploadDir) try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch {}
    if (runRecord.status === 'running') {
      runRecord.status = code === 0 ? 'done' : 'error';
      runRecord.exitCode = code;
      runRecord.endTime = new Date().toISOString();
    }
    const pausedForInput = code === 0 && !!runRecord.sessionId
      && runRecord.output.some(l => l.type === 'ask_user');
    runRecord.pausedForInput = pausedForInput;
    saveCommandRuns();
    send({ type: 'done', code, signal, sessionId: runRecord.sessionId, pausedForInput });
    runEmitters.delete(recId);
    if (!res.writableEnded) try { res.end(); } catch {}
  });
  proc.on('error', err => { send({ type: 'error', message: `spawn error: ${err.message}` }); });
  // SSE client disconnected — detach listener but keep process running
  res.on('close', () => {
    emitter.off('data', onInitialData);
  });
});

// Reconnect to a running (or completed) run — replays buffered output then streams live
app.get('/api/run-claude/:runId/stream', (req, res) => {
  const runRecord = commandRunsStore.find(r => r.id === req.params.runId);
  if (!runRecord) return res.status(404).json({ error: 'Run not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Allow caller to skip already-seen events (e.g. new tab that loaded run history)
  const from = parseInt(req.query.from, 10) || 0;

  // Replay buffered output from the requested offset
  for (const data of runRecord.output.slice(from)) {
    if (res.writableEnded) return;
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { return; }
  }

  // If already finished, close immediately
  if (runRecord.status !== 'running') {
    try { res.end(); } catch {}
    return;
  }

  // Subscribe to live events
  const emitter = runEmitters.get(runRecord.id);
  if (!emitter) { try { res.end(); } catch {} return; }

  const onData = (data) => {
    if (!res.writableEnded) {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
    }
  };
  emitter.on('data', onData);
  res.on('close', () => emitter.off('data', onData));
});

// Explicitly kill a running process
app.delete('/api/run-claude/:runId', (req, res) => {
  const { runId } = req.params;
  const proc = claudeProcs.get(runId);
  if (proc) { proc.kill(); claudeProcs.delete(runId); }
  const runRecord = commandRunsStore.find(r => r.id === runId);
  if (runRecord && runRecord.status === 'running') {
    runRecord.status = 'killed';
    runRecord.endTime = new Date().toISOString();
    saveCommandRuns();
    const emitter = runEmitters.get(runId);
    if (emitter) {
      emitter.emit('data', { type: 'meta', message: '⚠ Process killed by user' });
      runEmitters.delete(runId);
    }
  }
  res.json({ success: true });
});

app.post('/api/run-claude/:runId/input', (req, res) => {
  const proc = claudeProcs.get(req.params.runId);
  if (!proc) return res.status(404).json({ error: 'Run not found or already finished' });
  const { message } = req.body;
  if (typeof message !== 'string') return res.status(400).json({ error: 'message required' });
  try {
    proc.stdin.write(message + '\n');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resume a run in-place — streams the reply back into the same run record
app.post('/api/run-claude/:runId/continue', (req, res) => {
  const run = commandRunsStore.find(r => r.id === req.params.runId);
  if (!run?.sessionId) return res.status(400).json({ error: 'No session ID available for this run' });

  const { message, allowPermissions } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  // Mutate the existing run back to running state
  const prevSessionId = run.sessionId;
  run.status = 'running';
  run.endTime = null;
  run.pausedForInput = false;
  run.sessionId = null;
  run.allowPermissions = allowPermissions !== false;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Re-create emitter for this run (previous one was deleted on prior close)
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);
  runEmitters.set(run.id, emitter);

  const outputStartIdx = run.output.length;
  const send = (data) => {
    if (data.type !== 'start') run.output.push(data);
    emitter.emit('data', data);
  };
  const onInitialData = (data) => {
    if (!res.writableEnded) try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  };
  emitter.on('data', onInitialData);
  try { res.write(`data: ${JSON.stringify({ type: 'start', message: '' })}\n\n`); } catch {}

  // Visual separator showing the user's reply
  send({ type: 'meta', message: `\n↩ You: ${message}` });

  const args = ['--resume', prevSessionId, '-p', message, '--output-format', 'stream-json', '--verbose'];
  if (allowPermissions) args.push('--dangerously-skip-permissions');

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: run.projectPath,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  claudeProcs.set(run.id, proc);

  let stdoutBuf = '';
  proc.stdout.on('data', d => {
    stdoutBuf += d.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'assistant') {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'text' && block.text) {
              send({ type: 'output', message: block.text });
            } else if (block.type === 'tool_use') {
              if (block.name === 'AskUserQuestion') {
                send({ type: 'ask_user', message: block.input?.question ?? '', options: block.input?.options ?? [] });
              } else {
                send({ type: 'tool', message: `⚙ ${block.name}`, detail: toolDetail(block.name, block.input) });
              }
            }
          }
        } else if (event.type === 'user') {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'tool_result') {
              const content = Array.isArray(block.content)
                ? block.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
                : String(block.content ?? '');
              if (content) send({ type: 'tool_result', message: content.slice(0, 500) });
            }
          }
        } else if (event.type === 'result') {
          if (event.is_error) send({ type: 'error', message: event.result ?? 'Unknown error' });
          if (event.session_id) run.sessionId = event.session_id;
        }
      } catch {
        send({ type: 'output', message: line });
      }
    }
  });
  proc.stderr.on('data', d => send({ type: 'error', message: d.toString() }));
  proc.on('close', (code, signal) => {
    claudeProcs.delete(run.id);
    if (run.status === 'running') {
      run.status = code === 0 ? 'done' : 'error';
      run.exitCode = code;
      run.endTime = new Date().toISOString();
    }
    // Only check output added during THIS continuation for ask_user
    const pausedForInput = code === 0 && !!run.sessionId
      && run.output.slice(outputStartIdx).some(l => l.type === 'ask_user');
    run.pausedForInput = pausedForInput;
    saveCommandRuns();
    send({ type: 'done', code, signal, sessionId: run.sessionId, pausedForInput });
    runEmitters.delete(run.id);
    if (!res.writableEnded) try { res.end(); } catch {}
  });
  proc.on('error', err => { send({ type: 'error', message: `spawn error: ${err.message}` }); });
  res.on('close', () => { emitter.off('data', onInitialData); });
});

app.get('/api/command-runs', (_req, res) => res.json(commandRunsStore));

app.delete('/api/command-runs', (_req, res) => {
  commandRunsStore.length = 0;
  saveCommandRuns();
  res.json({ success: true });
});

app.delete('/api/command-runs/:id', (req, res) => {
  const idx = commandRunsStore.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  commandRunsStore.splice(idx, 1);
  saveCommandRuns();
  res.json({ success: true });
});

// ─── Webhook trigger system ───────────────────────────────────────────────────

const WEBHOOKS_FILE = path.join(__dirname, 'webhooks.json');
const WEBHOOK_RUNS_FILE = path.join(__dirname, 'webhook-runs.json');
const MAX_WEBHOOK_RUNS = 100;

function loadWebhookRuns() {
  try {
    const runs = JSON.parse(fs.readFileSync(WEBHOOK_RUNS_FILE, 'utf8'));
    return runs.map(r => r.status === 'running'
      ? { ...r, status: 'interrupted', endTime: new Date().toISOString() }
      : r);
  } catch { return []; }
}

function saveWebhookRuns() {
  try { fs.writeFileSync(WEBHOOK_RUNS_FILE, JSON.stringify(webhookRunsStore, null, 2)); } catch {}
}

const webhookRunsStore = loadWebhookRuns(); // newest first, persisted
const webhookProcs = new Map(); // execId → child process

function loadWebhooks() {
  try { return JSON.parse(fs.readFileSync(WEBHOOKS_FILE, 'utf8')); } catch { return []; }
}

function saveWebhooks(webhooks) {
  fs.writeFileSync(WEBHOOKS_FILE, JSON.stringify(webhooks, null, 2));
}

// Resolve {{a.b.c}} template tokens against a JSON payload
function resolveTemplate(template, payload) {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, dotPath) => {
    const val = dotPath.trim().split('.').reduce((obj, k) => obj?.[k], payload);
    return val != null ? String(val) : '';
  });
}

// Extract last balanced JSON object from text (Claude typically appends a JSON summary block)
function extractLastJson(text) {
  let depth = 0, end = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === '}') { if (end === -1) end = i; depth++; }
    else if (text[i] === '{') {
      if (--depth === 0 && end !== -1) {
        try { return JSON.parse(text.slice(i, end + 1)); } catch { end = -1; }
      }
    }
  }
  return {};
}

// Convert "PROJ-123 targetFile=src/auth.ts" → { arg0: 'PROJ-123', targetFile: 'src/auth.ts' }
function parseArgsToJson(str) {
  if (!str?.trim()) return {};
  const obj = {};
  str.trim().split(/\s+/).forEach((p, i) => {
    obj[`arg${i}`] = p;
    const kv = p.match(/^(\w+)=(.+)$/);
    if (kv) obj[kv[1]] = kv[2];
  });
  return obj;
}

function addWebhookRun(run) {
  webhookRunsStore.unshift(run);
  if (webhookRunsStore.length > MAX_WEBHOOK_RUNS) webhookRunsStore.pop();
}

function spawnWebhookProcess(run) {
  const args = ['-p', run.prompt, '--output-format', 'stream-json', '--verbose'];
  if (run.allowPermissions) args.push('--dangerously-skip-permissions');

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: run.projectPath,
    env: { ...process.env },
    stdio: [run.allowPermissions ? 'ignore' : 'pipe', 'pipe', 'pipe']
  });

  webhookProcs.set(run.execId, proc);

  let stdoutBuf = '';
  proc.stdout.on('data', d => {
    stdoutBuf += d.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'assistant') {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'text' && block.text) run.output.push({ type: 'output', message: block.text });
            else if (block.type === 'tool_use') {
              if (block.name === 'AskUserQuestion') {
                run.output.push({ type: 'ask_user', message: block.input?.question ?? '', options: block.input?.options ?? [] });
              } else {
                run.output.push({ type: 'tool', message: `⚙ ${block.name}` });
              }
            }
          }
        } else if (event.type === 'result' && event.is_error) {
          run.output.push({ type: 'error', message: event.result ?? 'Unknown error' });
        }
      } catch {
        run.output.push({ type: 'output', message: line });
      }
    }
  });
  proc.stderr.on('data', d => run.output.push({ type: 'error', message: d.toString() }));
  proc.on('close', (code) => {
    webhookProcs.delete(run.execId);
    if (run.status === 'running') {
      run.status = code === 0 ? 'done' : 'error';
      run.exitCode = code;
      run.endTime = new Date().toISOString();
    }
    saveWebhookRuns();
  });
  proc.on('error', err => {
    webhookProcs.delete(run.execId);
    if (run.status === 'running') {
      run.status = 'error';
      run.output.push({ type: 'error', message: `spawn error: ${err.message}` });
      run.endTime = new Date().toISOString();
    }
    saveWebhookRuns();
  });
}

// ── Webhook CRUD
app.get('/api/webhooks', (_req, res) => res.json(loadWebhooks()));

app.post('/api/webhooks', (req, res) => {
  const webhooks = loadWebhooks();
  const webhook = { id: Date.now().toString(), ...req.body, createdAt: new Date().toISOString() };
  webhooks.push(webhook);
  saveWebhooks(webhooks);
  res.json(webhook);
});

app.put('/api/webhooks/:id', (req, res) => {
  const webhooks = loadWebhooks();
  const idx = webhooks.findIndex(w => w.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  webhooks[idx] = { ...webhooks[idx], ...req.body };
  saveWebhooks(webhooks);
  res.json(webhooks[idx]);
});

app.delete('/api/webhooks/:id', (req, res) => {
  const webhooks = loadWebhooks().filter(w => w.id !== req.params.id);
  saveWebhooks(webhooks);
  res.json({ success: true });
});

// ── Recent runs
app.get('/api/webhooks/runs', (_req, res) => res.json(webhookRunsStore));

// ── Public trigger endpoint (called by external services, e.g. JIRA)
app.post('/webhooks/:triggerKey', (req, res) => {
  const config = loadWebhooks().find(w => w.triggerKey === req.params.triggerKey && w.enabled !== false);
  if (!config) return res.status(404).json({ error: 'Webhook trigger not found or disabled' });

  // Optional secret validation via X-Webhook-Secret header
  if (config.secret) {
    const provided = req.headers['x-webhook-secret'];
    if (provided !== config.secret) return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  const payload = req.body;
  const args = config.argTemplate ? resolveTemplate(config.argTemplate, payload).trim() : '';
  const prompt = args ? `/${config.command} ${args}` : `/${config.command}`;

  if (!config.projectPath?.startsWith(os.homedir())) {
    return res.status(400).json({ error: 'Webhook project path is not configured or invalid' });
  }

  const execId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const run = {
    execId,
    webhookId: config.id,
    webhookName: config.name,
    triggerKey: config.triggerKey,
    command: config.command,
    projectPath: config.projectPath,
    prompt,
    resolvedArgs: args,
    payload: JSON.stringify(payload).slice(0, 1000),
    status: 'running',
    output: [{ type: 'meta', message: `Triggered by webhook — ${prompt}` }],
    allowPermissions: config.allowPermissions ?? true,
    startTime: new Date().toISOString(),
    endTime: null,
    exitCode: null
  };

  addWebhookRun(run);
  spawnWebhookProcess(run);

  res.json({ success: true, execId, prompt });
});

// ── Send stdin input to a running webhook process
app.post('/api/webhooks/runs/:execId/input', (req, res) => {
  const proc = webhookProcs.get(req.params.execId);
  if (!proc) return res.status(404).json({ error: 'Run not found or already finished' });
  const { message } = req.body;
  if (typeof message !== 'string') return res.status(400).json({ error: 'message required' });
  try {
    proc.stdin.write(message + '\n');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Kill a running webhook process
app.delete('/api/webhooks/runs/:execId', (req, res) => {
  const run = webhookRunsStore.find(r => r.execId === req.params.execId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const proc = webhookProcs.get(req.params.execId);
  if (proc) {
    proc.kill();
    webhookProcs.delete(req.params.execId);
  }

  if (run.status === 'running') {
    run.status = 'killed';
    run.endTime = new Date().toISOString();
    run.output.push({ type: 'meta', message: '⚠ Process killed by user' });
  }

  saveWebhookRuns();
  res.json({ success: true });
});

app.delete('/api/webhooks/runs/:execId/remove', (req, res) => {
  const idx = webhookRunsStore.findIndex(r => r.execId === req.params.execId);
  if (idx === -1) return res.status(404).json({ error: 'Run not found' });
  webhookRunsStore.splice(idx, 1);
  saveWebhookRuns();
  res.json({ success: true });
});

// ── Test trigger (same logic, but initiated from the UI)
app.post('/api/webhooks/:id/test', (req, res) => {
  const config = loadWebhooks().find(w => w.id === req.params.id);
  if (!config) return res.status(404).json({ error: 'Webhook not found' });

  if (!config.projectPath?.startsWith(os.homedir())) {
    return res.status(400).json({ error: 'Webhook project path is not configured or invalid' });
  }

  const payload = req.body ?? {};
  const args = config.argTemplate ? resolveTemplate(config.argTemplate, payload).trim() : '';
  const prompt = args ? `/${config.command} ${args}` : `/${config.command}`;

  const execId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const run = {
    execId,
    webhookId: config.id,
    webhookName: config.name,
    triggerKey: config.triggerKey,
    command: config.command,
    projectPath: config.projectPath,
    prompt,
    resolvedArgs: args,
    payload: JSON.stringify(payload).slice(0, 1000),
    status: 'running',
    output: [{ type: 'meta', message: `Manual test — ${prompt}` }],
    allowPermissions: config.allowPermissions ?? true,
    startTime: new Date().toISOString(),
    endTime: null,
    exitCode: null
  };

  addWebhookRun(run);
  spawnWebhookProcess(run);

  res.json({ success: true, execId, prompt });
});

// ─── JIRA Poll system ─────────────────────────────────────────────────────────

const POLLS_FILE = path.join(__dirname, 'polls.json');
const POLL_RUNS_FILE = path.join(__dirname, 'poll-runs.json');
const MAX_POLL_RUNS = 100;

function loadPollRuns() {
  try {
    const runs = JSON.parse(fs.readFileSync(POLL_RUNS_FILE, 'utf8'));
    return runs.map(r => r.status === 'running'
      ? { ...r, status: 'interrupted', endTime: new Date().toISOString() }
      : r);
  } catch { return []; }
}
function savePollRuns() {
  try { fs.writeFileSync(POLL_RUNS_FILE, JSON.stringify(pollRunsStore, null, 2)); } catch {}
}

const pollRunsStore = loadPollRuns(); // newest first
const pollProcs = new Map(); // execId → child process
const pollSeenKeys = new Map(); // pollId → Set<issueKey> (in-memory dedup per session)
const bbSeenCommits = new Map(); // pollId → last seen commit hash

function loadPolls() {
  try { return JSON.parse(fs.readFileSync(POLLS_FILE, 'utf8')); } catch { return []; }
}

function savePolls(polls) {
  fs.writeFileSync(POLLS_FILE, JSON.stringify(polls, null, 2));
}

function getBitbucketConfig() {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8'));
    const bbConfig = settings.mcpServers?.bitbucket;
    if (!bbConfig) return null;
    const args = bbConfig.args || [];
    const tokenIdx = args.indexOf('--bitbucket-token');
    const wsIdx    = args.indexOf('--default-workspace');
    const token     = tokenIdx >= 0 ? args[tokenIdx + 1] : null;
    const workspace = wsIdx    >= 0 ? args[wsIdx    + 1] : null;
    if (!token || !workspace) return null;
    return { token, workspace };
  } catch { return null; }
}

function getAtlassianConfig() {
  try {
    // 1. Check plugins.local.md for jira_url + jira_pat (on-prem / PAT auth)
    const pluginsPath = path.join(CLAUDE_DIR, 'plugins.local.md');
    if (fs.existsSync(pluginsPath)) {
      const pluginsText = fs.readFileSync(pluginsPath, 'utf8');
      const jiraUrl = (pluginsText.match(/^jira_url:\s*(.+)$/m) || [])[1]?.trim();
      const jiraPat = (pluginsText.match(/^jira_pat:\s*(.+)$/m) || [])[1]?.trim();
      if (jiraUrl && jiraPat) return { baseUrl: jiraUrl, pat: jiraPat };
    }
    // 2. Fall back to settings.json env vars (Atlassian Cloud / email+token)
    const settings = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8'));
    const mcpEnv = settings.mcpServers?.atlassian?.env || {};
    const settingsEnv = settings.env || {};
    const baseUrl = mcpEnv.ATLASSIAN_BASE_URL || settingsEnv.ATLASSIAN_BASE_URL || '';
    const email = mcpEnv.ATLASSIAN_EMAIL || settingsEnv.ATLASSIAN_EMAIL || '';
    const token = mcpEnv.ATLASSIAN_API_TOKEN || settingsEnv.ATLASSIAN_API_TOKEN || '';
    if (!baseUrl || !email || !token) return null;
    return { baseUrl, email, token };
  } catch { return null; }
}

async function queryJiraIssues(jqlFilter, config, maxResults = 10) {
  // PAT (Bearer) auth for Jira Server/DC uses api/2; Basic auth (Cloud) uses api/3
  const apiVersion = config.pat ? '2' : '3';
  const url = `${config.baseUrl}/rest/api/${apiVersion}/search?jql=${encodeURIComponent(jqlFilter)}&maxResults=${maxResults}&fields=key,summary,status,assignee,issuetype`;
  const authHeader = config.pat
    ? `Bearer ${config.pat}`
    : `Basic ${Buffer.from(`${config.email}:${config.token}`).toString('base64')}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': authHeader,
      'Accept': 'application/json'
    }
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Jira API ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

function addPollRun(run) {
  pollRunsStore.unshift(run);
  if (pollRunsStore.length > MAX_POLL_RUNS) pollRunsStore.pop();
}

function spawnPollProcess(run) {
  const args = ['-p', run.prompt, '--output-format', 'stream-json', '--verbose'];
  if (run.allowPermissions) args.push('--dangerously-skip-permissions');

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: run.projectPath,
    env: { ...process.env },
    stdio: [run.allowPermissions ? 'ignore' : 'pipe', 'pipe', 'pipe']
  });

  pollProcs.set(run.execId, proc);

  let stdoutBuf = '';
  proc.stdout.on('data', d => {
    stdoutBuf += d.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'assistant') {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'text' && block.text) run.output.push({ type: 'output', message: block.text });
            else if (block.type === 'tool_use') {
              if (block.name === 'AskUserQuestion') {
                run.output.push({ type: 'ask_user', message: block.input?.question ?? '', options: block.input?.options ?? [] });
              } else {
                run.output.push({ type: 'tool', message: `⚙ ${block.name}`, detail: toolDetail(block.name, block.input) });
              }
            }
          }
        } else if (event.type === 'user') {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'tool_result') {
              const content = Array.isArray(block.content)
                ? block.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
                : String(block.content ?? '');
              if (content) run.output.push({ type: 'tool_result', message: content.slice(0, 500) });
            }
          }
        } else if (event.type === 'result' && event.is_error) {
          run.output.push({ type: 'error', message: event.result ?? 'Unknown error' });
        }
      } catch {
        run.output.push({ type: 'output', message: line });
      }
    }
  });
  proc.stderr.on('data', d => run.output.push({ type: 'error', message: d.toString() }));
  proc.on('close', (code) => {
    pollProcs.delete(run.execId);
    if (run.status === 'running') {
      run.status = code === 0 ? 'done' : 'error';
      run.exitCode = code;
      run.endTime = new Date().toISOString();
    }
    savePollRuns();
  });
  proc.on('error', err => {
    pollProcs.delete(run.execId);
    if (run.status === 'running') {
      run.status = 'error';
      run.output.push({ type: 'error', message: `spawn error: ${err.message}` });
      run.endTime = new Date().toISOString();
    }
    savePollRuns();
  });
}

function createPollRun(pollConfig, issue) {
  const issueCtx = {
    key: issue.key,
    summary: issue.fields?.summary || '',
    status: issue.fields?.status?.name || '',
    assignee: issue.fields?.assignee?.displayName || '',
    type: issue.fields?.issuetype?.name || ''
  };
  const args = pollConfig.argTemplate
    ? resolveTemplate(pollConfig.argTemplate, issueCtx).trim()
    : issue.key;
  const prompt = args ? `/${pollConfig.command} ${args}` : `/${pollConfig.command}`;
  const execId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    execId,
    source: 'poll',
    pollId: pollConfig.id,
    pollName: pollConfig.name,
    issueKey: issue.key,
    issueSummary: issueCtx.summary,
    command: pollConfig.command,
    projectPath: pollConfig.projectPath,
    prompt,
    resolvedArgs: args,
    status: 'running',
    output: [{ type: 'meta', message: `Poll "${pollConfig.name}" — ${prompt}\n  issue: ${issue.key} — ${issueCtx.summary}` }],
    allowPermissions: pollConfig.allowPermissions ?? true,
    startTime: new Date().toISOString(),
    endTime: null,
    exitCode: null
  };
}

async function runPollCheck(pollConfig) {
  const config = getAtlassianConfig();
  if (!config) {
    console.warn(`  ⚠ Poll "${pollConfig.name}": no Atlassian config in settings.json`);
    return;
  }

  // Update lastRun immediately to prevent double-firing if check takes >1 minute
  const polls = loadPolls();
  const idx = polls.findIndex(p => p.id === pollConfig.id);
  if (idx >= 0) {
    polls[idx].lastRun = new Date().toISOString();
    polls[idx].nextRun = new Date(Date.now() + Math.max(5, pollConfig.intervalMinutes || 30) * 60_000).toISOString();
    savePolls(polls);
  }

  try {
    const maxPerRun = pollConfig.maxPerRun || 5;
    const data = await queryJiraIssues(pollConfig.jqlFilter, config, maxPerRun);
    const issues = (data.issues || []).slice(0, maxPerRun);

    if (!pollSeenKeys.has(pollConfig.id)) {
      // First run since startup: establish baseline without triggering
      pollSeenKeys.set(pollConfig.id, new Set(issues.map(i => i.key)));
      console.log(`  ◑ Poll "${pollConfig.name}": baseline ${issues.length} issue(s), no trigger on first run`);
      return;
    }

    const seen = pollSeenKeys.get(pollConfig.id);
    const newIssues = issues.filter(i => !seen.has(i.key));
    if (newIssues.length === 0) {
      console.log(`  ◑ Poll "${pollConfig.name}": no new issues`);
      return;
    }

    for (const issue of newIssues) {
      if (!pollConfig.projectPath?.startsWith(os.homedir())) continue;
      seen.add(issue.key);
      const run = createPollRun(pollConfig, issue);
      addPollRun(run);
      spawnPollProcess(run);
      console.log(`  ⚡ Poll "${pollConfig.name}": triggered for ${issue.key}`);
    }
  } catch (e) {
    console.error(`  ✗ Poll "${pollConfig.name}" error:`, e.message);
  }
}

async function runBitbucketCheck(pollConfig) {
  const bbConfig = getBitbucketConfig();
  if (!bbConfig) {
    console.warn(`  ⚠ Bitbucket Poll "${pollConfig.name}": no Bitbucket config in settings.json`);
    return;
  }

  const polls = loadPolls();
  const idx = polls.findIndex(p => p.id === pollConfig.id);
  if (idx >= 0) {
    polls[idx].lastRun = new Date().toISOString();
    polls[idx].nextRun = new Date(Date.now() + Math.max(5, pollConfig.intervalMinutes || 30) * 60_000).toISOString();
    savePolls(polls);
  }

  try {
    const workspace = pollConfig.bbWorkspace || bbConfig.workspace;
    const repo = pollConfig.bbRepo;
    const branch = pollConfig.bbBranch || 'main';

    const resp = await fetch(
      `https://api.bitbucket.org/2.0/repositories/${workspace}/${repo}/commits/${branch}?pagelen=1`,
      { headers: { Authorization: `Bearer ${bbConfig.token}`, Accept: 'application/json' } }
    );
    if (!resp.ok) throw new Error(`Bitbucket API ${resp.status}: ${await resp.text().then(t => t.slice(0, 100))}`);

    const data = await resp.json();
    const latest = (data.values || [])[0];
    if (!latest) return;

    const hash = latest.hash;
    const shortHash = hash.slice(0, 8);

    if (!bbSeenCommits.has(pollConfig.id)) {
      bbSeenCommits.set(pollConfig.id, hash);
      console.log(`  ◑ Bitbucket Poll "${pollConfig.name}": baseline ${shortHash}, no trigger on first run`);
      return;
    }

    if (bbSeenCommits.get(pollConfig.id) === hash) {
      console.log(`  ◑ Bitbucket Poll "${pollConfig.name}": no new commits`);
      return;
    }

    bbSeenCommits.set(pollConfig.id, hash);

    const commitCtx = {
      hash,
      shortHash,
      message: (latest.message || '').split('\n')[0].slice(0, 80),
      author: latest.author?.user?.display_name || latest.author?.raw?.replace(/<[^>]*>/g, '').trim() || 'unknown',
      branch,
      repo,
    };

    if (!pollConfig.projectPath?.startsWith(os.homedir())) return;

    const resolvedArgs = pollConfig.argTemplate
      ? resolveTemplate(pollConfig.argTemplate, commitCtx).trim()
      : shortHash;
    const prompt = pollConfig.command
      ? (resolvedArgs ? `/${pollConfig.command} ${resolvedArgs}` : `/${pollConfig.command}`)
      : resolvedArgs;

    const execId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const run = {
      execId, source: 'poll',
      pollId: pollConfig.id, pollName: pollConfig.name,
      issueKey: shortHash, issueSummary: commitCtx.message,
      command: pollConfig.command, projectPath: pollConfig.projectPath,
      prompt, resolvedArgs,
      status: 'running',
      output: [{ type: 'meta', message: `Bitbucket Poll "${pollConfig.name}" — ${prompt}\n  commit: ${shortHash} — ${commitCtx.message}` }],
      allowPermissions: pollConfig.allowPermissions ?? true,
      startTime: new Date().toISOString(), endTime: null, exitCode: null,
    };
    addPollRun(run);
    spawnPollProcess(run);
    console.log(`  ⚡ Bitbucket Poll "${pollConfig.name}": triggered for ${shortHash}`);
  } catch (e) {
    console.error(`  ✗ Bitbucket Poll "${pollConfig.name}" error:`, e.message);
  }
}

// Check polls every minute
setInterval(() => {
  const now = Date.now();
  loadPolls()
    .filter(p => p.enabled !== false && p.command && p.projectPath)
    .forEach(poll => {
      const intervalMs = Math.max(5, poll.intervalMinutes || 30) * 60_000;
      const nextRun = poll.lastRun ? new Date(poll.lastRun).getTime() + intervalMs : 0;
      if (now >= nextRun) {
        if (poll.sourceType === 'bitbucket' && poll.bbRepo) {
          runBitbucketCheck(poll).catch(e => console.error('Bitbucket poll error:', e.message));
        } else if (poll.jqlFilter) {
          runPollCheck(poll).catch(e => console.error('Poll error:', e.message));
        }
      }
    });
}, 60_000);

// ── Poll CRUD
app.get('/api/polls', (_req, res) => res.json(loadPolls()));

app.post('/api/polls', (req, res) => {
  const polls = loadPolls();
  const poll = { id: Date.now().toString(), ...req.body, lastRun: null, createdAt: new Date().toISOString() };
  polls.push(poll);
  savePolls(polls);
  res.json(poll);
});

app.put('/api/polls/:id', (req, res) => {
  const polls = loadPolls();
  const idx = polls.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  polls[idx] = { ...polls[idx], ...req.body };
  savePolls(polls);
  res.json(polls[idx]);
});

app.delete('/api/polls/:id', (req, res) => {
  savePolls(loadPolls().filter(p => p.id !== req.params.id));
  pollSeenKeys.delete(req.params.id);
  bbSeenCommits.delete(req.params.id);
  res.json({ success: true });
});

app.get('/api/polls/runs', (_req, res) => res.json(pollRunsStore));

app.post('/api/polls/runs/:execId/input', (req, res) => {
  const proc = pollProcs.get(req.params.execId);
  if (!proc) return res.status(404).json({ error: 'Run not found or already finished' });
  const { message } = req.body;
  if (typeof message !== 'string') return res.status(400).json({ error: 'message required' });
  try {
    proc.stdin.write(message + '\n');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/polls/runs/:execId', (req, res) => {
  const run = pollRunsStore.find(r => r.execId === req.params.execId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const proc = pollProcs.get(req.params.execId);
  if (proc) { proc.kill(); pollProcs.delete(req.params.execId); }
  if (run.status === 'running') {
    run.status = 'killed';
    run.endTime = new Date().toISOString();
    run.output.push({ type: 'meta', message: '⚠ Process killed by user' });
  }
  savePollRuns();
  res.json({ success: true });
});

app.delete('/api/polls/runs/:execId/remove', (req, res) => {
  const idx = pollRunsStore.findIndex(r => r.execId === req.params.execId);
  if (idx === -1) return res.status(404).json({ error: 'Run not found' });
  pollRunsStore.splice(idx, 1);
  savePollRuns();
  res.json({ success: true });
});

// Test: query JIRA / Bitbucket and fire (bypasses dedup)
app.post('/api/polls/:id/test', async (req, res) => {
  const config = loadPolls().find(p => p.id === req.params.id);
  if (!config) return res.status(404).json({ error: 'Poll not found' });
  if (!config.projectPath?.startsWith(os.homedir())) {
    return res.status(400).json({ error: 'Poll project path is not configured or invalid' });
  }

  // Bitbucket test: fetch latest commit and fire once (bypasses seen-commit dedup)
  if (config.sourceType === 'bitbucket') {
    const bbConfig = getBitbucketConfig();
    if (!bbConfig) return res.status(400).json({ error: 'No Bitbucket config found in settings.json' });
    try {
      const workspace = config.bbWorkspace || bbConfig.workspace;
      const branch = config.bbBranch || 'main';
      const resp = await fetch(
        `https://api.bitbucket.org/2.0/repositories/${workspace}/${config.bbRepo}/commits/${branch}?pagelen=1`,
        { headers: { Authorization: `Bearer ${bbConfig.token}`, Accept: 'application/json' } }
      );
      if (!resp.ok) throw new Error(`Bitbucket API ${resp.status}`);
      const data = await resp.json();
      const latest = (data.values || [])[0];
      if (!latest) return res.json({ success: true, message: 'No commits found on branch', execIds: [] });

      const commitCtx = {
        hash: latest.hash,
        shortHash: latest.hash.slice(0, 8),
        message: (latest.message || '').split('\n')[0].slice(0, 80),
        author: latest.author?.user?.display_name || latest.author?.raw?.replace(/<[^>]*>/g, '').trim() || 'unknown',
        branch,
        repo: config.bbRepo,
      };
      const resolvedArgs = config.argTemplate
        ? resolveTemplate(config.argTemplate, commitCtx).trim()
        : commitCtx.shortHash;
      const prompt = config.command
        ? (resolvedArgs ? `/${config.command} ${resolvedArgs}` : `/${config.command}`)
        : resolvedArgs;

      const execId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const run = {
        execId, source: 'poll',
        pollId: config.id, pollName: config.name,
        issueKey: commitCtx.shortHash, issueSummary: commitCtx.message,
        command: config.command, projectPath: config.projectPath,
        prompt, resolvedArgs,
        status: 'running',
        output: [{ type: 'meta', message: `Test run — ${prompt}\n  commit: ${commitCtx.shortHash} — ${commitCtx.message}` }],
        allowPermissions: config.allowPermissions ?? true,
        startTime: new Date().toISOString(), endTime: null, exitCode: null,
      };
      addPollRun(run);
      spawnPollProcess(run);
      return res.json({ success: true, issueCount: 1, execIds: [execId] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // JIRA test
  const jiraConfig = getAtlassianConfig();
  if (!jiraConfig) return res.status(400).json({ error: 'No Atlassian config found in settings.json' });
  try {
    const maxPerRun = config.maxPerRun || 5;
    const data = await queryJiraIssues(config.jqlFilter, jiraConfig, maxPerRun);
    const issues = (data.issues || []).slice(0, maxPerRun);
    if (issues.length === 0) {
      return res.json({ success: true, message: 'No issues matched the JQL filter', execIds: [] });
    }
    const execIds = [];
    for (const issue of issues) {
      const run = createPollRun(config, issue);
      addPollRun(run);
      spawnPollProcess(run);
      execIds.push(run.execId);
    }
    res.json({ success: true, issueCount: issues.length, execIds });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Script Templates ─────────────────────────────────────────────────────────

const TEMPLATES_FILE = path.join(__dirname, 'templates.json');

function loadTemplates() {
  try { return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8')); } catch { return []; }
}
function saveTemplates(list) {
  try { fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(list, null, 2)); } catch {}
}

app.get('/api/templates', (_req, res) => res.json(loadTemplates()));

app.post('/api/templates', (req, res) => {
  const { name, description, command, args, freePrompt, projectPath, allowPermissions, argDefs } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const tmpl = {
    id: `tmpl-${Date.now()}`,
    name, description: description || '',
    command: command || '', args: args || '', freePrompt: freePrompt || '',
    projectPath: projectPath || '',
    allowPermissions: allowPermissions !== false,
    argDefs: Array.isArray(argDefs) ? argDefs : [],
    createdAt: new Date().toISOString()
  };
  const list = loadTemplates();
  list.push(tmpl);
  saveTemplates(list);
  res.json(tmpl);
});

app.put('/api/templates/:id', (req, res) => {
  const list = loadTemplates();
  const idx = list.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Template not found' });
  list[idx] = { ...list[idx], ...req.body, id: req.params.id };
  saveTemplates(list);
  res.json(list[idx]);
});

app.delete('/api/templates/:id', (req, res) => {
  const list = loadTemplates();
  if (!list.find(t => t.id === req.params.id)) return res.status(404).json({ error: 'Template not found' });
  saveTemplates(list.filter(t => t.id !== req.params.id));
  res.json({ success: true });
});

// ─── Workflows ────────────────────────────────────────────────────────────────

const WORKFLOWS_FILE = path.join(__dirname, 'workflows.json');
const WORKFLOW_RUNS_FILE = path.join(__dirname, 'workflow-runs.json');
const MAX_WORKFLOW_RUNS = 50;

function loadWorkflows() {
  try { return JSON.parse(fs.readFileSync(WORKFLOWS_FILE, 'utf8')); } catch { return []; }
}
function saveWorkflows(list) {
  try { fs.writeFileSync(WORKFLOWS_FILE, JSON.stringify(list, null, 2)); } catch {}
}
function loadWorkflowRuns() {
  try {
    const runs = JSON.parse(fs.readFileSync(WORKFLOW_RUNS_FILE, 'utf8'));
    return runs.map(r => r.status === 'running'
      ? { ...r, status: 'interrupted', endTime: new Date().toISOString() }
      : r);
  } catch { return []; }
}
function saveWorkflowRuns() {
  try { fs.writeFileSync(WORKFLOW_RUNS_FILE, JSON.stringify(workflowRunsStore, null, 2)); } catch {}
}

const workflowRunsStore = loadWorkflowRuns();
const workflowProcs = new Map(); // execId → child process

// Spawn a single workflow step and return a Promise<exitCode>
function spawnWorkflowStep(prompt, template, run, stepIndex) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    if (template.allowPermissions) args.push('--dangerously-skip-permissions');

    const proc = spawn(CLAUDE_BIN, args, {
      cwd: template.projectPath,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    workflowProcs.set(run.execId, proc);

    let buf = '';
    proc.stdout.on('data', d => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'assistant') {
            for (const block of event.message?.content ?? []) {
              if (block.type === 'text' && block.text) {
                run.output.push({ type: 'output', message: block.text, stepIndex });
              } else if (block.type === 'tool_use' && block.name !== 'AskUserQuestion') {
                run.output.push({ type: 'tool', message: `⚙ ${block.name}`, detail: toolDetail(block.name, block.input), stepIndex });
              }
            }
          } else if (event.type === 'user') {
            for (const block of event.message?.content ?? []) {
              if (block.type === 'tool_result') {
                const content = Array.isArray(block.content)
                  ? block.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
                  : String(block.content ?? '');
                if (content) run.output.push({ type: 'tool_result', message: content.slice(0, 500), stepIndex });
              }
            }
          } else if (event.type === 'result' && event.is_error) {
            run.output.push({ type: 'error', message: event.result ?? 'Unknown error', stepIndex });
          }
        } catch {
          run.output.push({ type: 'output', message: line, stepIndex });
        }
      }
    });
    proc.stderr.on('data', d => run.output.push({ type: 'error', message: d.toString(), stepIndex }));
    proc.on('close', (code) => { workflowProcs.delete(run.execId); resolve(code ?? 1); });
    proc.on('error', (err) => {
      workflowProcs.delete(run.execId);
      run.output.push({ type: 'error', message: `spawn error: ${err.message}`, stepIndex });
      resolve(1);
    });
  });
}

async function runWorkflow(workflowId, initialArgs = '') {
  const workflow = loadWorkflows().find(w => w.id === workflowId);
  if (!workflow) return;
  const templates = loadTemplates();

  const execId = `wf-run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const run = {
    execId, source: 'workflow',
    workflowId: workflow.id, workflowName: workflow.name,
    status: 'running', output: [],
    currentStep: 0, totalSteps: workflow.steps.length,
    startTime: new Date().toISOString(), endTime: null, exitCode: null
  };
  workflowRunsStore.unshift(run);
  if (workflowRunsStore.length > MAX_WORKFLOW_RUNS) workflowRunsStore.pop();
  saveWorkflowRuns();

  let prevJson = {};
  const inputPayload = parseArgsToJson(initialArgs);

  for (let i = 0; i < workflow.steps.length; i++) {
    if (run.status === 'cancelled') break;

    const step = workflow.steps[i];
    const template = templates.find(t => t.id === step.templateId);
    if (!template) {
      run.output.push({ type: 'error', message: `Step ${i + 1}: template "${step.templateId}" not found`, stepIndex: i });
      run.status = 'error';
      break;
    }

    run.output.push({
      type: 'step_separator',
      message: `── Step ${i + 1} / ${workflow.steps.length}: ${step.label || template.name} ──`,
      stepIndex: i
    });
    run.currentStep = i;
    saveWorkflowRuns();

    // Resolve args with {{prev.*}} and {{input.*}} tokens
    const resolvedArgs = step.argsOverride != null && step.argsOverride !== ''
      ? resolveTemplate(step.argsOverride, { prev: prevJson, input: inputPayload })
      : template.args;

    let prompt;
    if (template.command) {
      prompt = resolvedArgs?.trim()
        ? `/${template.command} ${resolvedArgs.trim()}`
        : `/${template.command}`;
    } else {
      prompt = resolveTemplate(template.freePrompt || '', { prev: prevJson, input: inputPayload });
    }

    if (!prompt || !template.projectPath) {
      run.output.push({ type: 'error', message: `Step ${i + 1}: template has no prompt or projectPath`, stepIndex: i });
      run.status = 'error';
      break;
    }

    const exitCode = await spawnWorkflowStep(prompt, template, run, i);

    if (run.status === 'cancelled') break;
    if (exitCode !== 0) {
      run.output.push({ type: 'error', message: `Step ${i + 1} failed (exit ${exitCode})`, stepIndex: i });
      run.status = 'error';
      run.exitCode = exitCode;
      break;
    }

    // Extract JSON from this step's text output for next step's {{prev.*}} tokens
    const stepText = run.output.filter(e => e.stepIndex === i && e.type === 'output').map(e => e.message).join('\n');
    prevJson = extractLastJson(stepText);
  }

  if (run.status === 'running') { run.status = 'done'; run.exitCode = 0; }
  run.currentStep = workflow.steps.length;
  run.endTime = new Date().toISOString();
  saveWorkflowRuns();
}

app.get('/api/workflows', (_req, res) => res.json(loadWorkflows()));

app.post('/api/workflows', (req, res) => {
  const { name, description, steps } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const wf = {
    id: `wf-${Date.now()}`,
    name, description: description || '',
    steps: Array.isArray(steps) ? steps : [],
    createdAt: new Date().toISOString()
  };
  const list = loadWorkflows();
  list.push(wf);
  saveWorkflows(list);
  res.json(wf);
});

app.put('/api/workflows/:id', (req, res) => {
  const list = loadWorkflows();
  const idx = list.findIndex(w => w.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Workflow not found' });
  list[idx] = { ...list[idx], ...req.body, id: req.params.id };
  saveWorkflows(list);
  res.json(list[idx]);
});

app.delete('/api/workflows/:id', (req, res) => {
  const list = loadWorkflows();
  if (!list.find(w => w.id === req.params.id)) return res.status(404).json({ error: 'Workflow not found' });
  saveWorkflows(list.filter(w => w.id !== req.params.id));
  res.json({ success: true });
});

app.post('/api/workflows/:id/run', (req, res) => {
  const workflow = loadWorkflows().find(w => w.id === req.params.id);
  if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
  const { initialArgs = '' } = req.body;
  runWorkflow(workflow.id, initialArgs).catch(console.error);
  res.json({ success: true });
});

app.get('/api/workflow-runs', (_req, res) => res.json(workflowRunsStore));

app.delete('/api/workflow-runs/:execId', (req, res) => {
  const run = workflowRunsStore.find(r => r.execId === req.params.execId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const proc = workflowProcs.get(req.params.execId);
  if (proc) { proc.kill(); workflowProcs.delete(req.params.execId); }
  if (run.status === 'running') {
    run.status = 'cancelled';
    run.endTime = new Date().toISOString();
    run.output.push({ type: 'meta', message: '⚠ Workflow cancelled by user' });
  }
  saveWorkflowRuns();
  res.json({ success: true });
});

app.delete('/api/workflow-runs/:execId/remove', (req, res) => {
  const idx = workflowRunsStore.findIndex(r => r.execId === req.params.execId);
  if (idx === -1) return res.status(404).json({ error: 'Run not found' });
  workflowRunsStore.splice(idx, 1);
  saveWorkflowRuns();
  res.json({ success: true });
});

// ─── Scheduled Runs ────────────────────────────────────────────────────────────

const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');
const SCHEDULE_RUNS_FILE = path.join(__dirname, 'schedule-runs.json');
const MAX_SCHEDULE_RUNS = 100;

function loadSchedules() {
  try { return JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8')); } catch { return []; }
}
function saveSchedules(list) {
  try { fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(list, null, 2)); } catch {}
}
function loadScheduleRuns() {
  try {
    const runs = JSON.parse(fs.readFileSync(SCHEDULE_RUNS_FILE, 'utf8'));
    return runs.map(r => r.status === 'running'
      ? { ...r, status: 'interrupted', endTime: new Date().toISOString() }
      : r);
  } catch { return []; }
}
function saveScheduleRuns() {
  try { fs.writeFileSync(SCHEDULE_RUNS_FILE, JSON.stringify(scheduleRunsStore, null, 2)); } catch {}
}

const scheduleRunsStore = loadScheduleRuns(); // newest first
const scheduleProcs = new Map();  // execId → child process
const scheduleTimers = new Map(); // scheduleId → timer handle

function buildSchedulePrompt(schedule) {
  if (schedule.command) {
    const base = `/${schedule.command}`;
    return schedule.args?.trim() ? `${base} ${schedule.args.trim()}` : base;
  }
  return schedule.freePrompt || '';
}

function addScheduleRun(run) {
  scheduleRunsStore.unshift(run);
  if (scheduleRunsStore.length > MAX_SCHEDULE_RUNS) scheduleRunsStore.pop();
}

function spawnScheduleProcess(run) {
  const args = ['-p', run.prompt, '--output-format', 'stream-json', '--verbose'];
  if (run.allowPermissions) args.push('--dangerously-skip-permissions');

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: run.projectPath,
    env: { ...process.env },
    stdio: [run.allowPermissions ? 'ignore' : 'pipe', 'pipe', 'pipe']
  });

  scheduleProcs.set(run.execId, proc);

  let stdoutBuf = '';
  proc.stdout.on('data', d => {
    stdoutBuf += d.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'assistant') {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'text' && block.text) run.output.push({ type: 'output', message: block.text });
            else if (block.type === 'tool_use') {
              if (block.name === 'AskUserQuestion') {
                run.output.push({ type: 'ask_user', message: block.input?.question ?? '', options: block.input?.options ?? [] });
              } else {
                run.output.push({ type: 'tool', message: `⚙ ${block.name}`, detail: toolDetail(block.name, block.input) });
              }
            }
          }
        } else if (event.type === 'user') {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'tool_result') {
              const content = Array.isArray(block.content)
                ? block.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
                : String(block.content ?? '');
              if (content) run.output.push({ type: 'tool_result', message: content.slice(0, 500) });
            }
          }
        } else if (event.type === 'result' && event.is_error) {
          run.output.push({ type: 'error', message: event.result ?? 'Unknown error' });
        }
      } catch {
        run.output.push({ type: 'output', message: line });
      }
    }
  });
  proc.stderr.on('data', d => run.output.push({ type: 'error', message: d.toString() }));
  proc.on('close', (code) => {
    scheduleProcs.delete(run.execId);
    if (run.status === 'running') {
      run.status = code === 0 ? 'done' : 'error';
      run.exitCode = code;
      run.endTime = new Date().toISOString();
    }
    saveScheduleRuns();
  });
  proc.on('error', err => {
    scheduleProcs.delete(run.execId);
    if (run.status === 'running') {
      run.status = 'error';
      run.output.push({ type: 'error', message: `spawn error: ${err.message}` });
      run.endTime = new Date().toISOString();
    }
    saveScheduleRuns();
  });
}

function triggerSchedule(schedule) {
  // Workflow-sourced schedules delegate to the workflow engine
  if (schedule.sourceType === 'workflow') {
    if (!schedule.workflowId) return null;
    runWorkflow(schedule.workflowId, schedule.workflowArgs || '').catch(console.error);
    const list = loadSchedules();
    const idx = list.findIndex(s => s.id === schedule.id);
    if (idx !== -1) {
      const intervalMs = (list[idx].intervalMinutes || 30) * 60 * 1000;
      list[idx].lastRun = new Date().toISOString();
      list[idx].nextRun = new Date(Date.now() + intervalMs).toISOString();
      saveSchedules(list);
    }
    console.log(`  ⏰ Schedule "${schedule.name}": triggered workflow`);
    return `wf-sched-${Date.now()}`;
  }

  const prompt = buildSchedulePrompt(schedule);
  if (!prompt || !schedule.projectPath) return null;

  const execId = `sched-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const run = {
    execId, source: 'schedule',
    scheduleId: schedule.id, scheduleName: schedule.name,
    prompt, projectPath: schedule.projectPath,
    allowPermissions: schedule.allowPermissions !== false,
    status: 'running', output: [],
    startTime: new Date().toISOString(), endTime: null, exitCode: null
  };
  addScheduleRun(run);
  spawnScheduleProcess(run);
  console.log(`  ⏰ Schedule "${schedule.name}": triggered`);

  const list = loadSchedules();
  const idx = list.findIndex(s => s.id === schedule.id);
  if (idx !== -1) {
    const intervalMs = (list[idx].intervalMinutes || 30) * 60 * 1000;
    list[idx].lastRun = run.startTime;
    list[idx].nextRun = new Date(Date.now() + intervalMs).toISOString();
    saveSchedules(list);
  }
  return execId;
}

function stopScheduleTimer(scheduleId) {
  const timer = scheduleTimers.get(scheduleId);
  if (timer) { clearInterval(timer); scheduleTimers.delete(scheduleId); }
}

function startScheduleTimer(schedule) {
  stopScheduleTimer(schedule.id);
  if (!schedule.enabled) return;

  const intervalMs = (schedule.intervalMinutes || 30) * 60 * 1000;

  // Fire immediately if overdue (e.g., after server restart)
  if (schedule.nextRun && new Date(schedule.nextRun).getTime() <= Date.now()) {
    triggerSchedule(schedule);
  }

  const timer = setInterval(() => {
    const list = loadSchedules();
    const current = list.find(s => s.id === schedule.id);
    if (!current?.enabled) { stopScheduleTimer(schedule.id); return; }
    triggerSchedule(current);
  }, intervalMs);

  scheduleTimers.set(schedule.id, timer);
}

// Init on server start
{
  const schedules = loadSchedules();
  const active = schedules.filter(s => s.enabled);
  active.forEach(startScheduleTimer);
  if (active.length > 0) console.log(`  ⏰ ${active.length} schedule(s) active`);
}

// ─── Schedule routes ──────────────────────────────────────────────────────────

app.get('/api/schedules', (_req, res) => res.json(loadSchedules()));

app.post('/api/schedules', (req, res) => {
  const { name, intervalMinutes, command, args, freePrompt, projectPath, allowPermissions, enabled,
          sourceType, workflowId, workflowArgs } = req.body;
  const isWorkflow = sourceType === 'workflow';
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!isWorkflow && !projectPath) return res.status(400).json({ error: 'projectPath is required' });
  const schedule = {
    id: `sched-${Date.now()}`,
    name, intervalMinutes: intervalMinutes || 30,
    sourceType: sourceType || 'prompt',
    command: command || '', args: args || '', freePrompt: freePrompt || '',
    projectPath: projectPath || '',
    workflowId: workflowId || '', workflowArgs: workflowArgs || '',
    allowPermissions: allowPermissions !== false,
    enabled: enabled !== false,
    createdAt: new Date().toISOString(), lastRun: null,
    nextRun: new Date(Date.now() + (intervalMinutes || 30) * 60 * 1000).toISOString()
  };
  const list = loadSchedules();
  list.push(schedule);
  saveSchedules(list);
  if (schedule.enabled) startScheduleTimer(schedule);
  res.json(schedule);
});

app.put('/api/schedules/:id', (req, res) => {
  const list = loadSchedules();
  const idx = list.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Schedule not found' });
  list[idx] = { ...list[idx], ...req.body, id: req.params.id };
  saveSchedules(list);
  stopScheduleTimer(req.params.id);
  if (list[idx].enabled) startScheduleTimer(list[idx]);
  res.json(list[idx]);
});

app.delete('/api/schedules/:id', (req, res) => {
  let list = loadSchedules();
  if (!list.find(s => s.id === req.params.id)) return res.status(404).json({ error: 'Schedule not found' });
  stopScheduleTimer(req.params.id);
  saveSchedules(list.filter(s => s.id !== req.params.id));
  res.json({ success: true });
});

app.get('/api/schedules/runs', (_req, res) => res.json(scheduleRunsStore));

app.post('/api/schedules/runs/:execId/input', (req, res) => {
  const proc = scheduleProcs.get(req.params.execId);
  if (!proc) return res.status(404).json({ error: 'Run not found or already finished' });
  const { message } = req.body;
  if (typeof message !== 'string') return res.status(400).json({ error: 'message required' });
  try {
    proc.stdin.write(message + '\n');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/schedules/runs/:execId', (req, res) => {
  const run = scheduleRunsStore.find(r => r.execId === req.params.execId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const proc = scheduleProcs.get(req.params.execId);
  if (proc) { proc.kill(); scheduleProcs.delete(req.params.execId); }
  if (run.status === 'running') {
    run.status = 'killed';
    run.endTime = new Date().toISOString();
    run.output.push({ type: 'meta', message: '⚠ Process killed by user' });
  }
  saveScheduleRuns();
  res.json({ success: true });
});

app.delete('/api/schedules/runs/:execId/remove', (req, res) => {
  const idx = scheduleRunsStore.findIndex(r => r.execId === req.params.execId);
  if (idx === -1) return res.status(404).json({ error: 'Run not found' });
  scheduleRunsStore.splice(idx, 1);
  saveScheduleRuns();
  res.json({ success: true });
});

app.post('/api/schedules/:id/run', (req, res) => {
  const schedule = loadSchedules().find(s => s.id === req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  if (schedule.sourceType === 'workflow') {
    if (!schedule.workflowId) return res.status(400).json({ error: 'Schedule has no workflow configured' });
  } else {
    const prompt = buildSchedulePrompt(schedule);
    if (!prompt) return res.status(400).json({ error: 'Schedule has no command or prompt configured' });
    if (!schedule.projectPath?.startsWith(os.homedir())) {
      return res.status(400).json({ error: 'Project path is not configured or invalid' });
    }
  }
  const execId = triggerSchedule(schedule);
  res.json({ success: true, execId });
});

// Serve built client
app.use(express.static(path.join(__dirname, 'client/dist')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'client/dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  Claude Flightdeck → http://localhost:${PORT}\n`);
});
