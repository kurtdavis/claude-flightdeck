import { useEffect, useState, useCallback, useRef } from 'react';
import ReactFlow, {
  Background, Controls, MiniMap,
  useNodesState, useEdgesState,
  MarkerType, Position, Handle,
  getBezierPath, EdgeLabelRenderer, BaseEdge
} from 'reactflow';
import 'reactflow/dist/style.css';

// ─── Constants ────────────────────────────────────────────────────────────────

const NODE_COLORS = {
  command:      { bg: '#0a1f3a', border: '#1f6feb', glow: '#1f6feb40', text: '#79c0ff', label: 'Command',      icon: '▸' },
  orchestrator: { bg: '#1c0a2e', border: '#db61a2', glow: '#db61a240', text: '#f778c1', label: 'Orchestrator', icon: '⊕' },
  agent:        { bg: '#1e1040', border: '#a371f7', glow: '#a371f740', text: '#d2b4fc', label: 'Agent',        icon: '◈' },
  skill:        { bg: '#071d12', border: '#2ea043', glow: '#2ea04340', text: '#56d364', label: 'Skill',        icon: '⚡' },
  hook:         { bg: '#2a1400', border: '#d29922', glow: '#d2992240', text: '#ffa657', label: 'Hook',         icon: '⚓' },
  service:      { bg: '#1a1a2e', border: '#e36209', glow: '#e3620940', text: '#f0883e', label: 'Service',      icon: '🔗' }
};

// Display categories (used for layout ordering and colour in both views)
const CATEGORIES      = ['command', 'orchestrator', 'agent', 'skill', 'hook', 'other'];
const CATEGORY_META   = {
  command:      { label: 'Commands',      color: '#1f6feb' },
  orchestrator: { label: 'Orchestrators', color: '#db61a2' },
  agent:        { label: 'Agents',        color: '#a371f7' },
  skill:        { label: 'Skills',        color: '#2ea043' },
  hook:         { label: 'Hooks',         color: '#d29922' },
  other:        { label: 'Others',        color: '#8b949e' },
};
const SECTION_HEADER_H = 42; // taller than domain header (28px)

function getOrchestratorIds(rawEdges) {
  const ids = new Set();
  rawEdges.filter(e => e.animated).forEach(e => ids.add(e.source));
  return ids;
}

function getCategory(node, orchestratorIds) {
  if (node.type === 'command') return 'command';
  if (node.type === 'agent')   return orchestratorIds.has(node.id) ? 'orchestrator' : 'agent';
  if (node.type === 'skill')   return 'skill';
  if (node.type === 'hook')    return 'hook';
  return 'other'; // service, etc.
}

const SERVICE_COLORS = {
  jira:       { border: '#0052cc', text: '#4c9aff', bg: '#031530', icon: 'J' },
  confluence: { border: '#1868db', text: '#6ba5ff', bg: '#04152a', icon: 'C' },
  bitbucket:  { border: '#2684ff', text: '#85b8ff', bg: '#031d3d', icon: 'B' },
  github:     { border: '#8b949e', text: '#c9d1d9', bg: '#161b22', icon: 'G' }
};

const COLUMN = { hook: 0, command: 260, agent: 560, skill: 860, service: 1160 };
const NODE_W_COMPACT  = 200;
const NODE_W_EXPANDED = 260;
const NODE_H_COMPACT  = 72;
const NODE_H_EXPANDED = 96;
const NODE_GAP = 10;
const DOMAIN_HEADER_H = 28;
const DOMAIN_GAP = 24;
const MAX_COLS   = 10;  // max columns before wrapping to more rows
const TYPE_GAP  = 14;   // horizontal gap between type groups

/** Compute grid rows dynamically so columns never exceed maxCols */
function gridRows(count, maxCols = MAX_COLS) {
  if (count <= maxCols) return 1;
  return Math.ceil(count / maxCols);
}

// Edge label → filter key
function edgeLabel(e) {
  if (e.animated) return 'spawns';
  if (e.data?.isAccess) return 'accesses';
  return 'uses';
}

// ─── Custom Node ──────────────────────────────────────────────────────────────

function ClaudeNode({ data }) {
  const { raw, dimmed, highlighted, selected, expanded } = data;

  const sc = raw.type === 'service' ? (SERVICE_COLORS[raw.service] || SERVICE_COLORS.github) : null;
  const c  = sc ? { ...NODE_COLORS.service, ...sc } : (NODE_COLORS[raw.displayCategory] || NODE_COLORS[raw.type] || NODE_COLORS.agent);

  const opacity = dimmed ? 0.18 : 1;
  const borderColor = selected ? '#f0883e' : highlighted ? c.border : `${c.border}99`;
  const boxShadow = selected
    ? `0 0 0 2px #f0883e, 0 0 16px #f0883e60`
    : highlighted
    ? `0 0 0 1.5px ${c.border}, 0 0 12px ${NODE_COLORS[raw.type]?.glow || '#e3620940'}`
    : 'none';

  const isService = raw.type === 'service';
  const w = expanded ? NODE_W_EXPANDED : NODE_W_COMPACT;
  const pathTail = raw.path ? raw.path.split('/').slice(-2).join('/') : '';

  return (
    <div style={{
      background: c.bg, border: `1.5px solid ${borderColor}`, borderRadius: 10,
      padding: expanded ? '10px 12px' : '8px 10px',
      width: w, opacity, boxShadow,
      transition: 'opacity 0.15s, box-shadow 0.15s, border-color 0.15s',
      cursor: 'pointer', position: 'relative'
    }}>
      <Handle type="target" position={Position.Left}  style={{ background: c.border, width: 8, height: 8, border: 'none' }} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
        {isService ? (
          <div style={{
            width: 22, height: 22, borderRadius: 5, background: `${c.border}22`,
            border: `1px solid ${c.border}`, display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 11, fontWeight: 800, color: c.border,
            flexShrink: 0, marginTop: 1, fontFamily: 'monospace'
          }}>
            {c.icon}
          </div>
        ) : (
          <span style={{ fontSize: 14, color: c.border, flexShrink: 0, marginTop: 1 }}>{c.icon}</span>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 9, color: `${c.border}cc`, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 2 }}>
            {isService ? 'External Service' : `${raw.displayCategory || raw.type}${raw.domain ? ` · ${raw.domain}` : ''}`}
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, color: c.text, wordBreak: 'break-word', lineHeight: 1.3 }}>
            {raw.label}
          </div>
          {expanded && pathTail && (
            <div style={{ fontSize: 9, color: '#484f58', marginTop: 4, wordBreak: 'break-all' }}>
              …/{pathTail}
            </div>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: c.border, width: 8, height: 8, border: 'none' }} />
    </div>
  );
}

// ─── Custom Edge with label ───────────────────────────────────────────────────

function ClaudeEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd, style }) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />
      {data?.label && data?.highlighted && (
        <EdgeLabelRenderer>
          <div style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            fontSize: 9, color: '#8b949e',
            background: '#161b22', padding: '1px 5px', borderRadius: 3,
            pointerEvents: 'none', border: '1px solid #30363d'
          }}>
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { claudeNode: ClaudeNode, domainHeader: DomainHeaderNode };
const edgeTypes = { claudeEdge: ClaudeEdge };

// ─── Layout builder ───────────────────────────────────────────────────────────

function buildLayout(rawNodes, rawEdges, expanded) {
  const nodeH = expanded ? NODE_H_EXPANDED : NODE_H_COMPACT;
  const nodeW = expanded ? NODE_W_EXPANDED : NODE_W_COMPACT;
  const cellW = nodeW + 12;
  const cellH = nodeH + NODE_GAP;
  const orchestratorIds = getOrchestratorIds(rawEdges);

  // Group by category in display order
  const catMap = {};
  CATEGORIES.forEach(c => catMap[c] = []);
  rawNodes.forEach(n => {
    const cat = getCategory(n, orchestratorIds);
    catMap[cat].push({ ...n, displayCategory: cat });
  });

  const resultNodes = [];
  let currentY = 20;

  for (const category of CATEGORIES) {
    const catNodes = catMap[category];
    if (catNodes.length === 0) continue;

    const meta = CATEGORY_META[category];
    const rows = gridRows(catNodes.length);
    const cols = Math.ceil(catNodes.length / rows);
    const sectionWidth = cols * cellW + 20;

    // Section header (large style)
    resultNodes.push({
      id: `__section_${category}`,
      type: 'domainHeader',
      position: { x: 0, y: currentY },
      data: { label: meta.label, color: meta.color, width: sectionWidth, large: true, count: catNodes.length },
      draggable: false, selectable: false,
      style: { padding: 0, background: 'transparent', border: 'none', pointerEvents: 'none' }
    });
    currentY += SECTION_HEADER_H + 10;

    // Dynamic-row grid, capped at MAX_COLS wide
    catNodes.forEach((n, i) => {
      const col = Math.floor(i / rows);
      const row = i % rows;
      resultNodes.push({
        id: n.id,
        type: 'claudeNode',
        position: { x: col * cellW, y: currentY + row * cellH },
        data: { raw: n, dimmed: false, highlighted: false, selected: false, expanded },
        style: { padding: 0, background: 'transparent', border: 'none' }
      });
    });

    currentY += rows * cellH + DOMAIN_GAP + 12;
  }

  return { nodes: resultNodes, edges: buildEdges(rawEdges) };
}

// ─── Domain header node ───────────────────────────────────────────────────────

function DomainHeaderNode({ data }) {
  if (data.large) {
    // Section header for Type view — bigger, bolder
    return (
      <div style={{ width: data.width || 400, borderBottom: `2px solid ${data.color || '#30363d'}`, paddingBottom: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: data.color || '#8b949e', textTransform: 'uppercase', letterSpacing: 1.8 }}>
          {data.label}
        </div>
        <div style={{ fontSize: 10, color: '#484f58', marginTop: 2 }}>{data.count} node{data.count !== 1 ? 's' : ''}</div>
      </div>
    );
  }
  // Category sub-label for Folder view (inside a domain)
  if (data.sub) {
    return (
      <div style={{ width: data.width || 400, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 9, fontWeight: 600, color: data.color || '#484f58', textTransform: 'uppercase', letterSpacing: 1 }}>
          {data.label}
        </span>
        <span style={{ fontSize: 9, color: '#30363d' }}>{data.count}</span>
      </div>
    );
  }
  // Domain header for Folder view
  return (
    <div style={{
      width: data.width || 400,
      borderBottom: `1px solid ${data.color || '#30363d'}`,
      display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 6
    }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: data.color || '#484f58', textTransform: 'uppercase', letterSpacing: 1.2 }}>
        ⬡ {data.label}
      </span>
      <span style={{ fontSize: 9, color: '#30363d' }}>{data.count} node{data.count !== 1 ? 's' : ''}</span>
    </div>
  );
}

// ─── Grouped layout ───────────────────────────────────────────────────────────

const DOMAIN_COLORS = ['#a371f7', '#1f6feb', '#2ea043', '#d29922', '#e36209', '#f85149', '#79c0ff', '#56d364'];

const MAX_FOLDER_COLS = 5;
const CAT_HEADER_H    = 20;
const CAT_GAP         = 8;

function buildGroupedLayout(rawNodes, rawEdges, expanded) {
  const nodeH = expanded ? NODE_H_EXPANDED : NODE_H_COMPACT;
  const nodeW = expanded ? NODE_W_EXPANDED : NODE_W_COMPACT;
  const cellW = nodeW + 12;
  const cellH = nodeH + NODE_GAP;
  const orchestratorIds = getOrchestratorIds(rawEdges);

  // Group by domain → category
  const domainMap = new Map();
  rawNodes.forEach(n => {
    const d = n.domain || 'other';
    if (!domainMap.has(d)) domainMap.set(d, {});
    const m = domainMap.get(d);
    const cat = getCategory(n, orchestratorIds);
    if (!m[cat]) m[cat] = [];
    m[cat].push({ ...n, displayCategory: cat });
  });

  // Alphabetical, 'other' first
  const sortedDomains = [...domainMap.keys()].sort((a, b) => {
    if (a === 'other') return -1;
    if (b === 'other') return 1;
    return a.localeCompare(b);
  });

  const resultNodes = [];
  let currentY = 20;
  let domainIdx = 0;

  for (const domain of sortedDomains) {
    const catMap = domainMap.get(domain);
    const domainColor = DOMAIN_COLORS[domainIdx % DOMAIN_COLORS.length];
    const nodeCount = Object.values(catMap).reduce((s, arr) => s + arr.length, 0);

    // Compute domain width from widest category (≤ MAX_FOLDER_COLS cols)
    let maxCols = 1;
    CATEGORIES.forEach(cat => {
      const len = (catMap[cat] || []).length;
      if (len > 0) maxCols = Math.max(maxCols, Math.min(len, MAX_FOLDER_COLS));
    });
    const domainWidth = Math.max(maxCols * cellW - 12 + 20, 200);

    // Domain header
    resultNodes.push({
      id: `__header_${domain}`,
      type: 'domainHeader',
      position: { x: 0, y: currentY },
      data: { label: domain, color: domainColor, count: nodeCount, width: domainWidth },
      draggable: false, selectable: false,
      style: { padding: 0, background: 'transparent', border: 'none', pointerEvents: 'none' }
    });
    currentY += DOMAIN_HEADER_H + 8;

    // Categories stacked top-to-bottom
    CATEGORIES.forEach(cat => {
      const catNodes = catMap[cat] || [];
      if (catNodes.length === 0) return;
      const meta = CATEGORY_META[cat];
      const cols = Math.min(catNodes.length, MAX_FOLDER_COLS);
      const rows = Math.ceil(catNodes.length / cols);

      // Category sub-label
      resultNodes.push({
        id: `__cat_${domain}_${cat}`,
        type: 'domainHeader',
        position: { x: 0, y: currentY },
        data: { label: meta.label, color: meta.color, count: catNodes.length, width: domainWidth, sub: true },
        draggable: false, selectable: false,
        style: { padding: 0, background: 'transparent', border: 'none', pointerEvents: 'none' }
      });
      currentY += CAT_HEADER_H + 4;

      // Nodes left-to-right, wrapping into rows
      catNodes.forEach((n, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        resultNodes.push({
          id: n.id,
          type: 'claudeNode',
          position: { x: col * cellW, y: currentY + row * cellH },
          data: { raw: n, dimmed: false, highlighted: false, selected: false, expanded },
          style: { padding: 0, background: 'transparent', border: 'none' }
        });
      });

      currentY += rows * cellH + CAT_GAP;
    });

    currentY += DOMAIN_GAP;
    domainIdx++;
  }

  return { nodes: resultNodes, edges: buildEdges(rawEdges) };
}

// Shared edge builder
function buildEdges(rawEdges) {
  return rawEdges.map(e => {
    const isAccess = e.label === 'accesses';
    const svcKey   = isAccess ? e.target?.replace('service:', '') : null;
    const svcColor = svcKey ? (SERVICE_COLORS[svcKey]?.border || '#e36209') : null;
    const baseStroke = isAccess ? `${svcColor}88` : '#30363d55';
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'claudeEdge',
      animated: e.animated,
      data: { label: e.label, highlighted: false, isAccess, svcColor },
      style: { stroke: baseStroke, strokeWidth: isAccess ? 1.5 : 1.2, strokeDasharray: isAccess ? '5 4' : undefined },
      markerEnd: { type: MarkerType.ArrowClosed, color: baseStroke, width: 12, height: 12 }
    };
  });
}

// ─── Detail Panel ─────────────────────────────────────────────────────────────

function DetailPanel({ node, allEdges, allNodes, onOpenEditor, onRunCommand, onFocus, isFocused, onClose }) {
  if (!node) return null;
  const c = NODE_COLORS[node.type] || NODE_COLORS.agent;
  const filePath = node.path?.replace(/.*\/\.claude\//, 'vh-agents/.claude/') || '';

  const connections = allEdges
    .filter(e => e.source === node.id || e.target === node.id)
    .map(e => {
      const otherId = e.source === node.id ? e.target : e.source;
      const other = allNodes.find(n => n.id === otherId);
      const dir = e.source === node.id ? '→' : '←';
      const lbl = e.label || (e.animated ? 'spawns' : 'uses');
      return { id: e.id, label: lbl, dir, otherLabel: other?.label || otherId, otherType: other?.type };
    });

  return (
    <div style={{
      position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 15,
      background: '#161b22', borderTop: `2px solid ${c.border}`,
      padding: '12px 16px', display: 'flex', gap: 20, alignItems: 'flex-start'
    }}>
      {/* Left: identity */}
      <div style={{ flexShrink: 0, minWidth: 200 }}>
        <div style={{ fontSize: 10, color: c.border, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>
          {c.icon} {node.type}{node.domain ? ` · ${node.domain}` : ''}
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, color: c.text, marginBottom: 4 }}>{node.label}</div>
        {filePath && <div style={{ fontSize: 10, color: '#484f58', wordBreak: 'break-all' }}>{filePath}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          {node.type === 'command' && onRunCommand && node.path && (
            <button onClick={() => onRunCommand(node.path)} style={detailBtnStyle('#1a3a1a', '#3fb950', '#238636')}>▶ Run</button>
          )}
          {node.path && (
            <button onClick={onOpenEditor} style={detailBtnStyle('#238636')}>Open in Editor</button>
          )}
          <button onClick={isFocused ? onClose : onFocus} style={detailBtnStyle(isFocused ? '#21262d' : '#1f4068', isFocused ? '#8b949e' : '#79c0ff', isFocused ? '#30363d' : '#1f6feb')}>
            {isFocused ? '← Show all' : '⊙ Focus'}
          </button>
          <button onClick={onClose} style={detailBtnStyle('#21262d', '#8b949e')}>✕</button>
        </div>
      </div>

      {/* Right: connections */}
      {connections.length > 0 && (
        <div style={{ flex: 1, overflow: 'auto', maxHeight: 120 }}>
          <div style={{ fontSize: 10, color: '#484f58', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>
            {connections.length} connection{connections.length !== 1 ? 's' : ''}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {connections.map(conn => {
              const oc = NODE_COLORS[conn.otherType] || NODE_COLORS.agent;
              return (
                <div key={conn.id} style={{
                  display: 'flex', alignItems: 'center', gap: 4, fontSize: 10,
                  background: '#0d1117', border: '1px solid #30363d', borderRadius: 4,
                  padding: '3px 7px'
                }}>
                  <span style={{ color: '#484f58' }}>{conn.dir}</span>
                  <span style={{ color: '#8b949e' }}>{conn.label}</span>
                  <span style={{ color: oc.text }}>{conn.otherLabel}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function detailBtnStyle(bg, color = '#e6edf3', borderColor) {
  return {
    background: bg, color, border: `1px solid ${borderColor || bg}`,
    borderRadius: 5, padding: '4px 10px', fontSize: 11, cursor: 'pointer'
  };
}

// ─── Legend ───────────────────────────────────────────────────────────────────

function Legend({ typeFilter, onTypeFilter, edgeFilter, onEdgeFilter }) {
  return (
    <div style={{
      position: 'absolute', top: 12, right: 12, zIndex: 10,
      background: '#0d1117cc', backdropFilter: 'blur(8px)',
      border: '1px solid #30363d', borderRadius: 10,
      padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8,
      minWidth: 160
    }}>
      <div style={{ fontSize: 10, color: '#484f58', textTransform: 'uppercase', letterSpacing: 0.8 }}>Node types</div>
      {Object.entries(NODE_COLORS).map(([type, c]) => {
        const active = typeFilter.has(type);
        return (
          <div key={type} onClick={() => onTypeFilter(type)} style={{
            display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
            opacity: active ? 1 : 0.35, transition: 'opacity 0.15s'
          }}>
            <div style={{
              width: 22, height: 22, background: active ? c.bg : 'transparent',
              border: `2px solid ${c.border}`, borderRadius: 5,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, color: c.border
            }}>
              {c.icon}
            </div>
            <span style={{ fontSize: 12, color: c.text }}>{c.label}s</span>
          </div>
        );
      })}

      {/* Edge type filters */}
      <div style={{ borderTop: '1px solid #30363d', paddingTop: 8 }}>
        <div style={{ fontSize: 10, color: '#484f58', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>Edge types</div>
        {[
          { key: 'spawns',   svg: <svg width="32" height="10"><defs><marker id="leg-spawns" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#a371f7"/></marker></defs><line x1="0" y1="5" x2="26" y2="5" stroke="#a371f7" strokeWidth="1.5" strokeDasharray="3 2" markerEnd="url(#leg-spawns)"/></svg>, label: 'spawns' },
          { key: 'uses',     svg: <svg width="32" height="10"><defs><marker id="leg-uses" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#30363d"/></marker></defs><line x1="0" y1="5" x2="26" y2="5" stroke="#30363d" strokeWidth="1.5" markerEnd="url(#leg-uses)"/></svg>, label: 'uses' },
          { key: 'accesses', svg: <svg width="32" height="10"><defs><marker id="leg-accesses" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#e36209"/></marker></defs><line x1="0" y1="5" x2="26" y2="5" stroke="#e36209" strokeWidth="1.5" strokeDasharray="4 3" markerEnd="url(#leg-accesses)"/></svg>, label: 'accesses' }
        ].map(({ key, svg, label }) => {
          const active = edgeFilter.has(key);
          return (
            <div key={key} onClick={() => onEdgeFilter(key)} style={{
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4,
              cursor: 'pointer', opacity: active ? 1 : 0.3, transition: 'opacity 0.15s'
            }}>
              {svg}
              <span style={{ fontSize: 10, color: '#8b949e' }}>{label}</span>
            </div>
          );
        })}
      </div>

      {/* Service sub-legend */}
      <div style={{ borderTop: '1px solid #30363d', paddingTop: 8 }}>
        <div style={{ fontSize: 10, color: '#484f58', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>Services</div>
        {Object.entries(SERVICE_COLORS).map(([key, sc]) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <div style={{
              width: 18, height: 18, borderRadius: 4, border: `1.5px solid ${sc.border}`,
              background: `${sc.border}15`, display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontSize: 10, fontWeight: 800, color: sc.border,
              fontFamily: 'monospace'
            }}>{sc.icon}</div>
            <span style={{ fontSize: 11, color: sc.text, textTransform: 'capitalize' }}>{key}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Search bar + toolbar ─────────────────────────────────────────────────────

function Toolbar({ search, onSearch, count, total, expanded, onToggleExpanded, viewMode, onToggleViewMode, isFocused, onClearFocus }) {
  return (
    <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ position: 'relative' }}>
        <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: '#484f58', fontSize: 13 }}>⌕</span>
        <input
          value={search}
          onChange={e => onSearch(e.target.value)}
          placeholder="Search nodes…"
          style={{
            background: '#0d1117cc', backdropFilter: 'blur(8px)',
            border: '1px solid #30363d', borderRadius: 8,
            color: '#e6edf3', fontSize: 12, padding: '6px 10px 6px 26px',
            outline: 'none', width: 200
          }}
        />
      </div>
      {search && (
        <span style={{ fontSize: 11, color: '#8b949e', background: '#161b22', border: '1px solid #30363d', padding: '3px 8px', borderRadius: 5 }}>
          {count} / {total}
        </span>
      )}

      {/* View mode toggle */}
      <div style={{ display: 'flex', background: '#0d1117', border: '1px solid #30363d', borderRadius: 6, overflow: 'hidden' }}>
        {[
          { key: 'type',   label: '⊞ Type' },
          { key: 'folder', label: '⬡ Folder' }
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => onToggleViewMode(key)}
            style={{
              background: viewMode === key ? '#1f4068' : 'transparent',
              color: viewMode === key ? '#79c0ff' : '#8b949e',
              border: 'none', padding: '5px 10px', fontSize: 11, cursor: 'pointer'
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <button
        onClick={onToggleExpanded}
        title={expanded ? 'Switch to compact nodes' : 'Switch to expanded nodes'}
        style={{
          background: expanded ? '#1f4068' : '#161b22', color: expanded ? '#79c0ff' : '#8b949e',
          border: `1px solid ${expanded ? '#1f6feb' : '#30363d'}`, borderRadius: 6,
          padding: '5px 10px', fontSize: 11, cursor: 'pointer'
        }}
      >
        {expanded ? '⊟ Compact' : '⊞ Expand'}
      </button>
      {isFocused && (
        <button
          onClick={onClearFocus}
          style={{
            background: '#1a2332', color: '#79c0ff',
            border: '1px solid #1f6feb', borderRadius: 6,
            padding: '5px 10px', fontSize: 11, cursor: 'pointer'
          }}
        >
          ← Show all
        </button>
      )}
    </div>
  );
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

function Tooltip({ node, pos }) {
  if (!node) return null;
  const c = NODE_COLORS[node.raw?.displayCategory] || NODE_COLORS[node.raw?.type] || NODE_COLORS.agent;
  const filePath = node.raw?.path?.replace(/.*\/\.claude\//, 'vh-agents/.claude/') || '';
  return (
    <div style={{
      position: 'absolute', left: pos.x + 16, top: pos.y - 8, zIndex: 20,
      background: '#161b22', border: `1px solid ${c.border}`,
      borderRadius: 8, padding: '8px 12px', maxWidth: 300,
      pointerEvents: 'none', boxShadow: `0 4px 20px ${c.glow}`
    }}>
      <div style={{ fontSize: 10, color: c.border, textTransform: 'uppercase', marginBottom: 4 }}>
        {c.icon} {node.raw?.type}
      </div>
      <div style={{ fontSize: 13, color: c.text, fontWeight: 600, marginBottom: 4 }}>{node.raw?.label}</div>
      {filePath && <div style={{ fontSize: 10, color: '#484f58', wordBreak: 'break-all' }}>{filePath}</div>}
      <div style={{ fontSize: 10, color: '#484f58', marginTop: 4 }}>Click to focus · Double-click to open file</div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function RelationshipGraph({ nodes: rawNodes = [], edges: rawEdges = [], selectedFile, onNodeClick, onRunCommand }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [baseNodes, setBaseNodes] = useState([]);
  const [baseEdges, setBaseEdges] = useState([]);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState(new Set(['agent', 'orchestrator', 'command', 'skill', 'hook', 'service']));
  const [edgeFilter, setEdgeFilter] = useState(new Set(['spawns', 'uses', 'accesses']));
  const [expanded, setExpanded] = useState(false);
  const [viewMode, setViewMode] = useState('type'); // 'folder' | 'type'
  const [focusedNodeId, setFocusedNodeId] = useState(null);
  const [detailNode, setDetailNode] = useState(null);
  const containerRef = useRef(null);

  // Rebuild layout when raw data, expanded mode, or view mode changes
  useEffect(() => {
    if (!rawNodes.length) return;
    const { nodes: n, edges: e } = viewMode === 'folder'
      ? buildGroupedLayout(rawNodes, rawEdges, expanded)
      : buildLayout(rawNodes, rawEdges, expanded);
    setBaseNodes(n);
    setBaseEdges(e);
    setNodes(n);
    setEdges(e);
  }, [rawNodes, rawEdges, expanded, viewMode]);

  // Update expanded flag on existing nodes without full re-layout
  useEffect(() => {
    setNodes(nds => nds.map(n => ({ ...n, data: { ...n.data, expanded } })));
  }, [expanded]);

  const getNeighbors = useCallback((nodeId, edges) => {
    const neighborIds = new Set([nodeId]);
    const activeEdgeIds = new Set();
    edges.forEach(e => {
      if (e.source === nodeId || e.target === nodeId) {
        neighborIds.add(e.source);
        neighborIds.add(e.target);
        activeEdgeIds.add(e.id);
      }
    });
    return { neighborIds, activeEdgeIds };
  }, []);

  const applyVisuals = useCallback((hovId, searchTerm, typeSet, edgeSet, focusId, selFile) => {
    const isHovering = !!hovId;
    const isSearching = searchTerm.length > 1;
    const isFocusing = !!focusId;

    const { neighborIds: hovNeighbors, activeEdgeIds: hovEdges } =
      hovId ? getNeighbors(hovId, baseEdges) : { neighborIds: new Set(), activeEdgeIds: new Set() };
    const { neighborIds: focusNeighbors } =
      focusId ? getNeighbors(focusId, baseEdges) : { neighborIds: new Set(), activeEdgeIds: new Set() };

    setNodes(nds => nds.map(n => {
      // Domain header nodes are always visible, no data processing needed
      if (n.type === 'domainHeader') return n;

      const raw = n.data.raw;
      const inFocus = !isFocusing || focusNeighbors.has(n.id);
      const matchesSearch = !isSearching || raw.label.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesType = raw.displayCategory === 'orchestrator'
        ? typeSet.has('orchestrator')
        : typeSet.has(raw.type);
      const isNeighbor = hovNeighbors.has(n.id);
      const isSelected = raw.path === selFile;

      const hidden = !matchesType || !inFocus;
      const dimmed = !hidden && (
        (isSearching && !matchesSearch) ||
        (isHovering && !isNeighbor)
      );
      const highlighted = !hidden && (isNeighbor || (isSearching && matchesSearch));

      return {
        ...n,
        hidden,
        data: { ...n.data, dimmed, highlighted, selected: isSelected, expanded }
      };
    }));

    setEdges(eds => eds.map(e => {
      const eLabel = edgeLabel(e);
      const filteredOut = !edgeSet.has(eLabel);
      const bothVisible = isFocusing ? (focusNeighbors.has(e.source) && focusNeighbors.has(e.target)) : true;
      const isActive = isHovering ? hovEdges.has(e.id) : true;

      const sourceNode = baseNodes.find(n => n.id === e.source);
      const srcType = sourceNode?.data?.raw?.type || 'agent';
      const svcColor = e.data?.svcColor;
      const isAccess = e.data?.isAccess;
      const activeColor = e.animated ? '#a371f7'
        : isAccess ? (svcColor || '#e36209')
        : (NODE_COLORS[srcType]?.border || '#30363d');

      const visible = !filteredOut && bothVisible;

      return {
        ...e,
        hidden: !visible,
        data: { ...e.data, highlighted: isActive && visible },
        animated: isActive && visible && e.animated,
        style: visible ? {
          stroke: isActive ? activeColor : '#30363d22',
          strokeWidth: isActive ? (isHovering ? 2 : isAccess ? 1.5 : 1.2) : 0.6,
          strokeDasharray: isAccess ? (isActive ? '5 4' : undefined) : undefined,
          opacity: isHovering ? (isActive ? 1 : 0.06) : 0.6,
          transition: 'stroke 0.15s, opacity 0.15s, stroke-width 0.15s'
        } : { opacity: 0 },
        markerEnd: visible ? {
          type: MarkerType.ArrowClosed,
          color: isActive ? activeColor : '#30363d22',
          width: 12, height: 12
        } : undefined
      };
    }));
  }, [getNeighbors, baseNodes, baseEdges, expanded]);

  useEffect(() => {
    applyVisuals(hoveredNode?.id, search, typeFilter, edgeFilter, focusedNodeId, selectedFile);
  }, [hoveredNode, search, typeFilter, edgeFilter, focusedNodeId, selectedFile, applyVisuals]);

  const handleNodeMouseEnter = useCallback((_evt, node) => {
    if (node.type === 'domainHeader') return;
    setHoveredNode(node.data.raw);
  }, []);
  const handleNodeMouseLeave = useCallback(() => setHoveredNode(null), []);
  const handleMouseMove = useCallback((e) => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    }
  }, []);

  // Single click → focus + detail panel
  const handleNodeClick = useCallback((_evt, node) => {
    if (node.type === 'domainHeader') return;
    const raw = node.data?.raw;
    if (!raw) return;
    setDetailNode(raw);
    setFocusedNodeId(raw.id);
  }, []);

  // Double click → open in editor
  const handleNodeDoubleClick = useCallback((_evt, node) => {
    if (node.type === 'domainHeader') return;
    if (node.data?.raw?.path) onNodeClick(node.data.raw.path);
  }, [onNodeClick]);

  // Click on canvas → clear focus + detail
  const handlePaneClick = useCallback(() => {
    setFocusedNodeId(null);
    setDetailNode(null);
  }, []);

  const toggleTypeFilter = useCallback((type) => {
    setTypeFilter(prev => {
      const next = new Set(prev);
      if (next.has(type)) { if (next.size > 1) next.delete(type); }
      else next.add(type);
      return next;
    });
  }, []);

  const toggleEdgeFilter = useCallback((key) => {
    setEdgeFilter(prev => {
      const next = new Set(prev);
      if (next.has(key)) { if (next.size > 1) next.delete(key); }
      else next.add(key);
      return next;
    });
  }, []);

  const searchMatchCount = search.length > 1
    ? baseNodes.filter(n => {
        if (n.type === 'domainHeader') return false;
        const raw = n.data?.raw;
        if (!raw) return false;
        const cat = raw.displayCategory === 'orchestrator' ? 'orchestrator' : raw.type;
        return typeFilter.has(cat) && raw.label.toLowerCase().includes(search.toLowerCase());
      }).length
    : 0;

  if (!rawNodes.length) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#484f58', gap: 10 }}>
        <div style={{ fontSize: 40 }}>⬡</div>
        <div style={{ fontSize: 14 }}>No relationships found</div>
        <div style={{ fontSize: 12 }}>Agent and command files will appear here with their connections</div>
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }} onMouseMove={handleMouseMove}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onNodeMouseEnter={handleNodeMouseEnter}
        onNodeMouseLeave={handleNodeMouseLeave}
        onPaneClick={handlePaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.1}
        maxZoom={2.5}
        attributionPosition="bottom-left"
        proOptions={{ hideAttribution: false }}
      >
        <Background color="#1c2128" gap={24} size={1} />
        <Controls style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8 }} />
        <MiniMap
          style={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: 8 }}
          nodeColor={n => NODE_COLORS[n.data?.raw?.type]?.border || '#30363d'}
          maskColor="#0d1117bb"
        />
      </ReactFlow>

      <Toolbar
        search={search}
        onSearch={setSearch}
        count={searchMatchCount}
        total={rawNodes.filter(n => typeFilter.has(n.type)).length}
        expanded={expanded}
        onToggleExpanded={() => setExpanded(v => !v)}
        viewMode={viewMode}
        onToggleViewMode={setViewMode}
        isFocused={!!focusedNodeId}
        onClearFocus={handlePaneClick}
      />
      <Legend
        typeFilter={typeFilter}
        onTypeFilter={toggleTypeFilter}
        edgeFilter={edgeFilter}
        onEdgeFilter={toggleEdgeFilter}
      />
      <Tooltip node={hoveredNode} pos={tooltipPos} />

      {!hoveredNode && !detailNode && (
        <div style={{
          position: 'absolute', bottom: 52, left: '50%', transform: 'translateX(-50%)',
          fontSize: 11, color: '#484f58', background: '#0d1117aa',
          padding: '4px 12px', borderRadius: 20, pointerEvents: 'none',
          border: '1px solid #21262d'
        }}>
          Hover to highlight · Click to focus · Double-click to open file
        </div>
      )}

      <DetailPanel
        node={detailNode}
        allEdges={rawEdges}
        allNodes={rawNodes}
        isFocused={!!focusedNodeId}
        onOpenEditor={() => detailNode?.path && onNodeClick(detailNode.path)}
        onRunCommand={onRunCommand}
        onFocus={() => setFocusedNodeId(detailNode?.id)}
        onClose={handlePaneClick}
      />
    </div>
  );
}
