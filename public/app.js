/* app.js — MCP Inspector dashboard frontend */

const wsStatus   = document.getElementById('ws-status');
const trafficList = document.getElementById('traffic-list');
const authSessions = document.getElementById('auth-sessions');
const detailContent = document.getElementById('detail-content');
const detailPath = document.getElementById('detail-path');
const targetBadge = document.getElementById('target-badge');
const btnClear = document.getElementById('btn-clear');

let entries = [];
let selectedId = null;
let authData = {};

const STAGE_LABELS = {
  initial_request: '① Request',
  challenge_401:   '② 401 ⚠',
  prm_discovery:   '③ PRM',
  token_request:   '④ Token',
  authenticated:   '⑤ Authed',
  success:         '✓ Done',
};

// ── WebSocket ────────────────────────────────────────────────────────────────
const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${wsProto}//${location.hostname}:${location.port}/__ws`);

ws.onopen = () => {
  wsStatus.textContent = '● connected';
  wsStatus.className = 'badge badge-green';
};
ws.onclose = () => {
  wsStatus.textContent = '● disconnected';
  wsStatus.className = 'badge badge-red';
};
ws.onerror = () => {
  wsStatus.textContent = '● error';
  wsStatus.className = 'badge badge-red';
};

ws.onmessage = (evt) => {
  const msg = JSON.parse(evt.data);
  switch (msg.type) {
    case 'traffic':
      addEntry(msg.data);
      break;
    case 'auth_sessions':
      msg.data.forEach(s => { authData[s.key] = s; });
      renderAuthSessions();
      break;
    case 'auth_update':
      authData[msg.data.key] = msg.data;
      renderAuthSessions();
      break;
    case 'sse_event':
      addSSEEvent(msg.data);
      break;
    case 'sse_disconnect':
      addSSEDisconnect(msg.data);
      break;
    case 'sse_error':
      addSSEErrorEntry(msg.data);
      break;
  }
};

// ── Load config ──────────────────────────────────────────────────────────────
fetch('/__api/config')
  .then(r => r.json())
  .then(cfg => {
    targetBadge.textContent = '→ ' + cfg.target;
    targetBadge.className = 'badge badge-blue';
  })
  .catch(() => {});

// Load existing log on page load
fetch('/__api/log')
  .then(r => r.json())
  .then(log => {
    // log is newest-first; render oldest first so list reads top-to-bottom as newest
    [...log].reverse().forEach(addEntry);
  })
  .catch(() => {});

fetch('/__api/auth')
  .then(r => r.json())
  .then(sessions => {
    sessions.forEach(s => { authData[s.key] = s; });
    renderAuthSessions();
  })
  .catch(() => {});

// ── Clear ────────────────────────────────────────────────────────────────────
btnClear.addEventListener('click', () => {
  entries = [];
  selectedId = null;
  trafficList.innerHTML = '';
  detailContent.textContent = 'Click a traffic entry to inspect it.';
  detailPath.textContent = '';
});

// ── Filters ──────────────────────────────────────────────────────────────────
const filterRPC  = document.getElementById('filter-rpc');
const filterAuth = document.getElementById('filter-auth');
const filterSSE  = document.getElementById('filter-sse');
const filterErr  = document.getElementById('filter-err');

[filterRPC, filterAuth, filterSSE, filterErr].forEach(el =>
  el.addEventListener('change', () => rerenderTraffic())
);

function shouldShow(entry) {
  if (entry.isJsonRpc && !filterRPC.checked) return false;
  if ((entry.statusCode === 401 || entry.wwwAuthenticate || entry.hasToken) && !filterAuth.checked) return false;
  if ((entry.isSSE || entry.streaming) && !filterSSE.checked) return false;
  if ((entry.direction === 'error' || entry.statusCode >= 400) && !filterErr.checked) return false;
  return true;
}

function rerenderTraffic() {
  trafficList.innerHTML = '';
  entries.slice().reverse().forEach(e => {
    if (shouldShow(e)) trafficList.appendChild(buildEntryEl(e));
  });
}

// ── Traffic entries ──────────────────────────────────────────────────────────
function addEntry(entry) {
  // Deduplicate by id
  if (entries.find(e => e.id === entry.id)) return;
  entries.push(entry);
  if (!shouldShow(entry)) return;
  const el = buildEntryEl(entry);
  trafficList.insertBefore(el, trafficList.firstChild);
}

function addSSEEvent(data) {
  const pseudo = {
    id: data.ts + 'sse',
    ts: data.ts,
    direction: 'sse',
    method: 'EVT',
    path: data.path,
    statusCode: null,
    isSSE: true,
    body: data.raw,
    authSessionKey: data.authSessionKey,
  };
  addEntry(pseudo);
}

function addSSEDisconnect(data) {
  addEntry({
    id: data.ts + 'ssed',
    ts: data.ts,
    direction: 'error',
    method: 'SSE',
    path: data.path,
    statusCode: null,
    isSSE: true,
    error: 'SSE stream disconnected',
    authSessionKey: data.authSessionKey,
  });
}

function addSSEErrorEntry(data) {
  addEntry({
    id: data.ts + 'ssee',
    ts: data.ts,
    direction: 'error',
    method: 'SSE',
    path: data.path,
    statusCode: null,
    isSSE: true,
    error: data.error,
    authSessionKey: data.authSessionKey,
  });
}

function buildEntryEl(entry) {
  const el = document.createElement('div');
  el.className = 'traffic-entry';
  el.dataset.id = entry.id;
  if (entry.id === selectedId) el.classList.add('selected');

  const dir = entry.direction;
  const isErr = dir === 'error' || entry.statusCode >= 400;
  const isSSE = entry.isSSE || entry.streaming;
  const isRPC = entry.isJsonRpc;
  const isAuth = entry.statusCode === 401 || !!entry.wwwAuthenticate || entry.hasToken;

  const dirLabel = dir === 'request' ? '↑ REQ' : dir === 'response' ? '↓ RES' : dir === 'sse' ? '⚡ SSE' : '✗ ERR';
  const dirClass = dir === 'request' ? 'req' : dir === 'response' ? 'res' : dir === 'sse' ? 'sse' : 'err';

  const statusCode = entry.statusCode;
  const statusClass = !statusCode ? 'status-null'
    : statusCode < 300 ? 'status-2xx'
    : statusCode < 400 ? 'status-2xx'
    : 'status-4xx';

  const tags = [];
  if (isRPC) tags.push(`<span class="tag tag-rpc">RPC${entry.rpcMethod ? ':' + entry.rpcMethod : ''}</span>`);
  if (isAuth && entry.statusCode === 401) tags.push(`<span class="tag tag-auth">401</span>`);
  if (entry.hasToken) tags.push(`<span class="tag tag-token">🔑</span>`);
  if (isSSE) tags.push(`<span class="tag tag-sse">SSE</span>`);
  if (isErr && !isAuth) tags.push(`<span class="tag tag-err">ERR</span>`);

  el.innerHTML = `
    <span class="entry-dir ${dirClass}">${dirLabel}</span>
    <span class="entry-status ${statusClass}">${statusCode || '—'}</span>
    <span class="entry-method">${entry.method || '—'}</span>
    <span class="entry-path" title="${entry.path}">${entry.path || ''}</span>
    <span class="entry-tags">${tags.join('')}</span>
  `;

  el.addEventListener('click', () => selectEntry(entry, el));
  return el;
}

function selectEntry(entry, el) {
  selectedId = entry.id;
  document.querySelectorAll('.traffic-entry.selected').forEach(e => e.classList.remove('selected'));
  el.classList.add('selected');
  detailPath.textContent = `${entry.method} ${entry.path}`;
  renderDetail(entry);
}

// ── Detail pane ───────────────────────────────────────────────────────────────
function renderDetail(entry) {
  const sections = [];

  if (entry.error) {
    sections.push(['Error', entry.error]);
  }
  if (entry.wwwAuthenticate) {
    sections.push(['WWW-Authenticate', entry.wwwAuthenticate]);
  }
  if (entry.headers) {
    sections.push(['Headers', entry.headers]);
  }
  if (entry.body !== undefined && entry.body !== null) {
    sections.push(['Body', entry.body]);
  }

  detailContent.innerHTML = sections.map(([label, value]) => {
    const rendered = typeof value === 'object'
      ? syntaxHighlight(JSON.stringify(value, null, 2))
      : escapeHtml(String(value));
    return `<div class="muted small" style="margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">${escapeHtml(label)}</div>${rendered}\n\n`;
  }).join('');
}

// ── Auth flow renderer ────────────────────────────────────────────────────────
function renderAuthSessions() {
  const sessions = Object.values(authData);
  if (!sessions.length) {
    authSessions.innerHTML = '<div class="no-sessions">No auth sessions yet. Send a request through the proxy.</div>';
    return;
  }
  authSessions.innerHTML = sessions.map(s => {
    const steps = s.steps || [];
    const stepsHtml = steps.map((step, i) => {
      const label = STAGE_LABELS[step.stage] || step.stage;
      const arrow = i < steps.length - 1 ? '<span class="step-arrow">→</span>' : '';
      return `<span class="auth-step step-${step.stage}">${escapeHtml(label)}</span>${arrow}`;
    }).join('');
    return `
      <div class="auth-session">
        <div class="auth-session-key">${escapeHtml(s.key)}</div>
        <div class="auth-steps">${stepsHtml || '<span class="muted small">pending…</span>'}</div>
      </div>
    `;
  }).join('');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function syntaxHighlight(json) {
  json = escapeHtml(json);
  return json.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = 'json-num';
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? 'json-key' : 'json-str';
      } else if (/true|false/.test(match)) {
        cls = 'json-bool';
      } else if (/null/.test(match)) {
        cls = 'json-null';
      }
      return `<span class="${cls}">${match}</span>`;
    }
  );
}
