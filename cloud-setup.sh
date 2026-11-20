#!/bin/bash
# Claude Agent Dashboard: hooks for claude.ai/code cloud sessions.
# Paste into your cloud environment's setup script (runs at the start of every session).
# Set DASH to your hosted dashboard. The token is NOT here: save it as the environment's
# network secret for that host, and the proxy adds "Authorization: Bearer <token>".
DASH="https://YOUR-DASHBOARD-HOST"
node - "$DASH" <<'JS' || true
const fs = require('fs'), path = require('path'), os = require('os');
const url = process.argv[2].replace(/\/+$/, '') + '/events';
const dir = path.join(os.homedir(), '.claude'), f = path.join(dir, 'settings.json');
fs.mkdirSync(dir, { recursive: true });
let s = {};
try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
s.hooks = s.hooks || {};
const http = { type: 'http', url, timeout: 2 };
const cmd = `curl -s -m 2 -o /dev/null -H 'Content-Type: application/json' --data-binary @- '${url}' || true`;
const evs = ['SessionEnd', 'SubagentStart', 'SubagentStop', 'PostToolUse', 'TaskCreated', 'TaskCompleted'];
const add = (ev, h) => {
  const g = s.hooks[ev] = s.hooks[ev] || [];
  if (JSON.stringify(g).includes(url)) return;
  g.push(ev === 'PostToolUse' ? { matcher: '*', hooks: [h] } : { hooks: [h] });
};
evs.forEach(ev => add(ev, http));
add('SessionStart', { type: 'command', command: cmd, timeout: 3 });
fs.writeFileSync(f, JSON.stringify(s, null, 2));
const md = path.join(dir, 'CLAUDE.md');
const line = "Always start work by writing a task list, and update each item's status as you finish it.";
const cur = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
if (!cur.includes(line)) fs.writeFileSync(md, cur + (cur ? '\n\n' : '') + line + '\n');
JS
