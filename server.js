#!/usr/bin/env node
// Claude Agent Dashboard — zero-dependency live progress board for Claude Code agents.
// POST /events  <- Claude Code HTTP hooks
// GET  /        -> dashboard page (index.html, self-contained)
// GET  /stream  -> Server-Sent Events snapshot feed
// GET  /state   -> current snapshot as JSON (debugging)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// Hosted mode: set DASHBOARD_TOKEN (and the platform sets PORT). The server then listens on all
// interfaces and requires the token for everything: hooks send `Authorization: Bearer <token>`,
// browsers open /?token=<token> once and get a long-lived cookie.
// The token can also live in .token next to server.js (written by `node install.js --lan`).
let TOKEN = process.env.DASHBOARD_TOKEN || '';
if (!TOKEN) { try { TOKEN = fs.readFileSync(path.join(__dirname, '.token'), 'utf8').trim(); } catch (_) {} }
const PORT = Number(process.env.CLAUDE_DASHBOARD_PORT || process.env.PORT) || 4777;
const HOST = process.env.CLAUDE_DASHBOARD_HOST || (TOKEN ? '0.0.0.0' : '127.0.0.1');
const DIR = __dirname;
const DATA_DIR = process.env.CLAUDE_DASHBOARD_DATA || DIR;
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const PAGE_FILE = path.join(DIR, 'index.html');

const SAVE_EVERY_MS = 3000;
const FINISHED_TTL_MS = 60 * 60 * 1000;        // clear finished agents after 1 hour
const ABANDONED_TTL_MS = 24 * 60 * 60 * 1000;  // drop agents silent for 24h (crashed sessions)
const MAX_BODY = 20 * 1024 * 1024;
const MAX_EVENTS_LOG = 50 * 1024 * 1024;       // rotate events.jsonl at 50 MB

// ---------------------------------------------------------------- state
// agents: key -> agent record. key = agent_id for subagents, session_id for main sessions.
// taskOwners: "<session_id>:<task_id>" -> agent key (so TaskCompleted without agent_id lands right)
let state = { agents: {}, taskOwners: {} };
try {
  const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (loaded && loaded.agents) state = { agents: loaded.agents, taskOwners: loaded.taskOwners || {} };
} catch (_) { /* first run or corrupt file: start empty */ }

let dirty = false;

function str(v) { return typeof v === 'string' ? v : v == null ? '' : String(v); }
function short(s, n) { s = str(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function projectName(cwd) {
  cwd = str(cwd).replace(/[\\/]+$/, '');
  if (!cwd) return 'unknown';
  return cwd.split(/[\\/]/).pop() || cwd;
}

function getAgent(ev, opts = {}) {
  const sessionId = str(ev.session_id) || 'unknown-session';
  const agentId = opts.forceMain ? '' : str(ev.agent_id);
  const key = agentId || sessionId;
  let a = state.agents[key];
  const now = Date.now();
  if (!a) {
    a = state.agents[key] = {
      key, sessionId, agentId: agentId || null,
      agentType: str(ev.agent_type) || (agentId ? 'subagent' : 'main'),
      cwd: str(ev.cwd), project: projectName(ev.cwd),
      startedAt: now, lastEventAt: now, endedAt: null, status: 'running',
      tasks: {}, taskOrder: [], tasksAdded: 0,
      lastTool: null, lastMessage: null,
    };
  }
  if (ev.agent_type && agentId) a.agentType = str(ev.agent_type);
  if (ev.cwd && !a.cwd) { a.cwd = str(ev.cwd); a.project = projectName(ev.cwd); }
  return a;
}

// Only SessionStart / SubagentStart revive a finished card; stray late events just update the timestamp.
function touch(a) { a.lastEventAt = Date.now(); }

// ---------------------------------------------------------------- tasks
function completedCount(a) { return a.taskOrder.filter(id => a.tasks[id] && a.tasks[id].status === 'completed').length; }

function addTask(a, id, fields) {
  id = str(id);
  if (!id) return null;
  let t = a.tasks[id];
  if (!t) {
    // If a subject-only placeholder exists for the same subject, adopt it under the real id.
    if (fields.subject) {
      const ph = 'subj:' + fields.subject;
      if (ph !== id && a.tasks[ph]) {
        t = a.tasks[ph]; delete a.tasks[ph];
        a.taskOrder[a.taskOrder.indexOf(ph)] = id;
        t.id = id; a.tasks[id] = t;
      }
    }
    if (!t) {
      if (completedCount(a) > 0) a.tasksAdded++;   // list grew after work started
      t = a.tasks[id] = { id, subject: '', status: 'pending', activeForm: '' };
      a.taskOrder.push(id);
    }
  }
  if (fields.subject) t.subject = str(fields.subject);
  if (fields.activeForm) t.activeForm = str(fields.activeForm);
  if (fields.status) setTaskStatus(a, id, fields.status);
  dirty = true;
  return t;
}

function setTaskStatus(a, id, status) {
  id = str(id); status = str(status);
  if (status === 'deleted') {
    delete a.tasks[id];
    a.taskOrder = a.taskOrder.filter(x => x !== id);
    return;
  }
  const t = a.tasks[id];
  if (!t) return;
  if (status === 'in_progress') {
    // Only one task is "current" at a time.
    for (const k of a.taskOrder) if (k !== id && a.tasks[k].status === 'in_progress') a.tasks[k].status = 'pending';
  }
  if (['pending', 'in_progress', 'completed'].includes(status)) t.status = status;
  dirty = true;
}

function ownerKey(ev, taskId) { return str(ev.session_id) + ':' + str(taskId); }

function rememberOwner(ev, a, taskId) { if (taskId) state.taskOwners[ownerKey(ev, taskId)] = a.key; }

function agentForTask(ev, taskId) {
  if (ev.agent_id) return getAgent(ev);
  const k = state.taskOwners[ownerKey(ev, taskId)];
  if (k && state.agents[k]) return state.agents[k];
  return getAgent(ev); // fall back to the main session card
}

// Pull a task id out of whatever a TaskCreate tool_response looks like.
function extractTaskId(resp) {
  if (resp == null) return '';
  if (typeof resp === 'string') {
    const m = resp.match(/task\s*#?\s*([A-Za-z0-9_-]+)/i);
    return m ? m[1] : '';
  }
  if (typeof resp !== 'object') return '';
  for (const k of ['taskId', 'task_id', 'id']) if (resp[k] != null && typeof resp[k] !== 'object') return str(resp[k]);
  if (resp.task && typeof resp.task === 'object') return extractTaskId(resp.task);
  if (Array.isArray(resp)) { for (const x of resp) { const id = extractTaskId(x && x.text != null ? x.text : x); if (id) return id; } return ''; }
  if (Array.isArray(resp.content)) return extractTaskId(resp.content);
  if (typeof resp.text === 'string') return extractTaskId(resp.text);
  if (typeof resp.result === 'string' || typeof resp.result === 'object') return extractTaskId(resp.result);
  return '';
}

function applyTodoWrite(a, todos) {
  if (!Array.isArray(todos)) return;
  const prevTodo = a.taskOrder.filter(id => id.startsWith('todo:')).length;
  const hadDone = completedCount(a) > 0;
  for (const id of a.taskOrder.filter(id => id.startsWith('todo:'))) delete a.tasks[id];
  a.taskOrder = a.taskOrder.filter(id => !id.startsWith('todo:'));
  let anyActive = false;
  todos.forEach((td, i) => {
    if (!td || typeof td !== 'object') return;
    const id = 'todo:' + i;
    let status = str(td.status) || 'pending';
    if (status === 'in_progress') { if (anyActive) status = 'pending'; anyActive = true; }
    a.tasks[id] = { id, subject: str(td.content || td.subject || td.title || td.text), status, activeForm: str(td.activeForm) };
    a.taskOrder.push(id);
  });
  if (hadDone && todos.length > prevTodo) a.tasksAdded += todos.length - prevTodo;
  dirty = true;
}

// ---------------------------------------------------------------- tools
function toolDetail(name, input) {
  input = input && typeof input === 'object' ? input : {};
  const file = input.file_path || input.notebook_path || input.path;
  switch (name) {
    case 'Edit': case 'MultiEdit': case 'Write': case 'Read': case 'NotebookEdit':
      return file ? relPath(file) : '';
    case 'Bash': return short(input.description || input.command, 60);
    case 'Grep': case 'Glob': return short(input.pattern, 50);
    case 'WebFetch': return short(input.url, 60);
    case 'WebSearch': return short(input.query, 60);
    case 'Task': case 'Agent': return short(input.description || input.subagent_type, 60);
    case 'TaskCreate': return short(input.subject, 60);
    case 'TaskUpdate': return '#' + str(input.taskId) + (input.status ? ' → ' + input.status : '');
    case 'TodoWrite': return Array.isArray(input.todos) ? input.todos.length + ' items' : '';
    case 'Skill': return short(input.skill, 40);
    default: return file ? relPath(file) : short(input.description || input.command || input.query || input.url || '', 50);
  }
}
let currentCwdForRel = '';
function relPath(p) {
  p = str(p);
  if (currentCwdForRel && p.startsWith(currentCwdForRel)) {
    const r = p.slice(currentCwdForRel.length).replace(/^[\\/]+/, '');
    if (r) return short(r, 60);
  }
  return short(p.split(/[\\/]/).slice(-2).join('/'), 60);
}

// ---------------------------------------------------------------- event handling
function handleEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  const name = str(ev.hook_event_name);
  const now = Date.now();
  currentCwdForRel = str(ev.cwd);

  switch (name) {
    case 'SessionStart': {
      const a = getAgent(ev, { forceMain: true });
      if (a.status === 'done') { a.status = 'running'; a.endedAt = null; }
      a.source = str(ev.source) || a.source;
      touch(a);
      break;
    }
    case 'SessionEnd': {
      const sid = str(ev.session_id);
      for (const a of Object.values(state.agents)) {
        if (a.sessionId === sid && a.status !== 'done') { a.status = 'done'; a.endedAt = now; a.lastEventAt = now; }
      }
      getAgent(ev, { forceMain: true }); // make sure a card exists
      const m = state.agents[sid]; if (m && !m.endedAt) { m.status = 'done'; m.endedAt = now; }
      break;
    }
    case 'SubagentStart': {
      const a = getAgent(ev);
      a.status = 'running'; a.endedAt = null; touch(a);
      break;
    }
    case 'SubagentStop': {
      const a = getAgent(ev);
      a.lastEventAt = now; a.status = 'done'; a.endedAt = now;
      if (ev.last_assistant_message) a.lastMessage = short(ev.last_assistant_message, 300);
      break;
    }
    case 'TaskCreated': {
      const a = ev.agent_id ? getAgent(ev) : agentForTask(ev, ev.task_id);
      addTask(a, ev.task_id, { subject: ev.task_subject });
      rememberOwner(ev, a, str(ev.task_id));
      touch(a);
      break;
    }
    case 'TaskCompleted': {
      const a = agentForTask(ev, ev.task_id);
      addTask(a, ev.task_id, { subject: ev.task_subject, status: 'completed' });
      rememberOwner(ev, a, str(ev.task_id));
      touch(a);
      break;
    }
    case 'PostToolUse': {
      const a = getAgent(ev);
      touch(a);
      const tool = str(ev.tool_name);
      const input = ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : {};
      a.lastTool = { name: tool, detail: toolDetail(tool, input), at: now };
      if (tool === 'TaskCreate') {
        const id = extractTaskId(ev.tool_response);
        const subject = str(input.subject);
        addTask(a, id || ('subj:' + subject), { subject, activeForm: input.activeForm });
        if (id) rememberOwner(ev, a, id);
      } else if (tool === 'TaskUpdate') {
        const id = str(input.taskId || input.task_id || input.id);
        if (id) {
          const owner = state.taskOwners[ownerKey(ev, id)];
          const target = (owner && state.agents[owner]) || a;
          if (!target.tasks[id] && input.status !== 'deleted') addTask(target, id, { subject: input.subject || ('Task #' + id) });
          if (input.subject && target.tasks[id]) target.tasks[id].subject = str(input.subject);
          if (input.activeForm && target.tasks[id]) target.tasks[id].activeForm = str(input.activeForm);
          if (input.status) setTaskStatus(target, id, input.status);
          rememberOwner(ev, target, id);
        }
      } else if (tool === 'TodoWrite') {
        applyTodoWrite(a, input.todos);
      }
      break;
    }
    default: {
      // Unknown/other hook events still count as activity.
      if (ev.session_id) touch(getAgent(ev));
    }
  }
  dirty = true;
  scheduleBroadcast();
}

// ---------------------------------------------------------------- snapshot / housekeeping
function snapshot() {
  const agents = Object.values(state.agents).map(a => {
    const order = a.taskOrder.filter(id => a.tasks[id]);
    const tasks = order.map(id => a.tasks[id]);
    const total = tasks.length;
    const done = tasks.filter(t => t.status === 'completed').length;
    const cur = tasks.find(t => t.status === 'in_progress');
    return {
      key: a.key, sessionId: a.sessionId, agentId: a.agentId, agentType: a.agentType,
      project: a.project, cwd: a.cwd, startedAt: a.startedAt, lastEventAt: a.lastEventAt,
      endedAt: a.endedAt, status: a.status, total, done, tasksAdded: a.tasksAdded,
      current: cur ? (cur.activeForm || cur.subject) : null,
      lastTool: a.lastTool, lastMessage: a.lastMessage,
      tasks: tasks.map(t => ({ s: t.subject, st: t.status })),
    };
  });
  return { now: Date.now(), agents };
}

function sweep() {
  const now = Date.now();
  let changed = false;
  for (const [k, a] of Object.entries(state.agents)) {
    if ((a.status === 'done' && a.endedAt && now - a.endedAt > FINISHED_TTL_MS) ||
        (now - a.lastEventAt > ABANDONED_TTL_MS)) {
      delete state.agents[k]; changed = true;
    }
  }
  if (changed) {
    for (const [k, v] of Object.entries(state.taskOwners)) if (!state.agents[v]) delete state.taskOwners[k];
    dirty = true; scheduleBroadcast();
  }
}

function save() {
  if (!dirty) return;
  dirty = false;
  const tmp = STATE_FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(state), err => {
    if (err) { dirty = true; return; }
    fs.rename(tmp, STATE_FILE, e => { if (e) dirty = true; });
  });
}

// ---------------------------------------------------------------- raw event log
let logStream = null;
let logSize = 0;
function openLog() {
  try { logSize = fs.statSync(EVENTS_FILE).size; } catch (_) { logSize = 0; }
  logStream = fs.createWriteStream(EVENTS_FILE, { flags: 'a' });
  logStream.on('error', () => { logStream = null; });
}
function logRaw(raw) {
  try {
    if (!logStream) openLog();
    if (logSize > MAX_EVENTS_LOG) {
      logStream.end();
      try { fs.renameSync(EVENTS_FILE, EVENTS_FILE.replace(/\.jsonl$/, '.1.jsonl')); } catch (_) {}
      openLog();
    }
    const line = JSON.stringify({ received_at: new Date().toISOString(), raw }) + '\n';
    logSize += Buffer.byteLength(line);
    if (logStream) logStream.write(line);
  } catch (_) {}
}

// ---------------------------------------------------------------- SSE
const clients = new Set();
let broadcastTimer = null;
function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const data = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
    for (const res of clients) { try { res.write(data); } catch (_) { clients.delete(res); } }
  }, 200);
}

// ---------------------------------------------------------------- HTTP
const crypto = require('crypto');
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function authorized(req, query) {
  if (!TOKEN) return true;
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ') && safeEq(h.slice(7).trim(), TOKEN)) return true;
  if (query.get('token') && safeEq(query.get('token'), TOKEN)) return true;
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)cad_token=([^;]+)/);
  return !!(m && safeEq(decodeURIComponent(m[1]), TOKEN));
}

const server = http.createServer((req, res) => {
  const [url, qs] = (req.url || '/').split('?');
  const query = new URLSearchParams(qs || '');

  if (req.method === 'GET' && url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }

  if (!authorized(req, query)) {
    // Hooks must never see an error: unauthorized POSTs get an empty 200 and are dropped.
    if (req.method === 'POST') { req.resume(); res.writeHead(200, { 'Content-Length': '0' }); res.end(); return; }
    res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('Open this page as /?token=<your DASHBOARD_TOKEN> once.'); return;
  }
  // Browser opened /?token=…: remember it in a cookie and drop it from the address bar.
  if (TOKEN && req.method === 'GET' && query.get('token')) {
    res.writeHead(302, {
      'Set-Cookie': `cad_token=${encodeURIComponent(TOKEN)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`,
      Location: url || '/',
    });
    res.end(); return;
  }

  if (req.method === 'POST' && url === '/events') {
    const chunks = []; let size = 0; let tooBig = false;
    req.on('data', c => { size += c.length; if (size <= MAX_BODY) chunks.push(c); else tooBig = true; });
    req.on('error', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Length': '0' }); res.end();   // reply first, process after
      if (tooBig) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      let ev = null;
      try { ev = JSON.parse(raw); } catch (_) { logRaw(raw); return; }
      logRaw(ev);
      try { handleEvent(ev); } catch (e) { console.error('handleEvent error:', e && e.stack); }
    });
    return;
  }

  if (req.method === 'GET' && url === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'GET' && url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(snapshot(), null, 2));
    return;
  }

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    fs.readFile(PAGE_FILE, (err, buf) => {
      if (err) { res.writeHead(500); res.end('index.html missing'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return;
  }

  if (req.method === 'POST' && url === '/clear-finished') {
    for (const [k, a] of Object.entries(state.agents)) if (a.status === 'done') delete state.agents[k];
    dirty = true; scheduleBroadcast();
    res.writeHead(200, { 'Content-Length': '0' }); res.end();
    return;
  }

  // Anything else: hooks must never see an error, so POSTs always get 200.
  if (req.method === 'POST') { req.resume(); res.writeHead(200, { 'Content-Length': '0' }); res.end(); return; }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
});

server.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {} });
server.on('error', err => {
  if (err.code === 'EADDRINUSE') { console.error(`Port ${PORT} already in use — is the dashboard already running?`); process.exit(1); }
  console.error(err);
});

setInterval(save, SAVE_EVERY_MS).unref();
setInterval(sweep, 60 * 1000).unref();
// Keep SSE connections alive through proxies/sleep.
setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch (_) {} } }, 20000).unref();

const PID_FILE = path.join(DIR, 'server.pid');
function shutdown() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (_) {}
  try { if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', e => console.error('uncaught:', e && e.stack));

sweep();
// `localhost` may resolve to ::1 for some clients; also listen there (loopback only). Ignore if IPv6 is off.
if (HOST === '127.0.0.1') {
  const v6 = http.createServer(server.listeners('request')[0]);
  v6.on('error', () => {});
  v6.listen(PORT, '::1');
}
server.listen(PORT, HOST, () => {
  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch (_) {}
  console.log(`Claude Agent Dashboard on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${TOKEN ? ' (token required)' : ''}`);
});
