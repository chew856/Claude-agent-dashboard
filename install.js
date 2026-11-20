#!/usr/bin/env node
// Installer for Claude Agent Dashboard. Zero dependencies.
//
//   node install.js            install: hooks + CLAUDE.md line + autostart + start server
//   node install.js uninstall  remove hooks, CLAUDE.md line and autostart; stop the server
//   node install.js start | stop | status
//
// Flags: --no-autostart  --no-claude-md  --no-hooks
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const DIR = __dirname;
const PORT = Number(process.env.CLAUDE_DASHBOARD_PORT) || 4777;
const HOOK_URL = `http://localhost:${PORT}/events`;
const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'PostToolUse', 'TaskCreated', 'TaskCompleted'];
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const CLAUDE_MD = path.join(CLAUDE_DIR, 'CLAUDE.md');
const MD_LINE = "Always start work by writing a task list, and update each item's status as you finish it.";
const PID_FILE = path.join(DIR, 'server.pid');
const LOG_FILE = path.join(DIR, 'server.log');
const NODE = process.execPath;
const SERVER = path.join(DIR, 'server.js');
const LABEL = 'com.claude-agent-dashboard';
const WIN_TASK = 'ClaudeAgentDashboard';

const args = process.argv.slice(2);
const cmd = (args.find(a => !a.startsWith('--')) || 'install').toLowerCase();
const flag = f => args.includes(f);

function log(...m) { console.log(...m); }
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function run(bin, argv) { const r = spawnSync(bin, argv, { encoding: 'utf8' }); return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') }; }

// ------------------------------------------------------------- hooks
function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  const txt = fs.readFileSync(SETTINGS, 'utf8');
  if (!txt.trim()) return {};
  try { return JSON.parse(txt); } catch (e) {
    throw new Error(`${SETTINGS} is not valid JSON (${e.message}). Fix it first — nothing was changed.`);
  }
}
function backupSettings() {
  if (!fs.existsSync(SETTINGS)) return null;
  const b = `${SETTINGS}.bak-${stamp()}`;
  fs.copyFileSync(SETTINGS, b);
  return b;
}
function writeSettings(s) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  const tmp = SETTINGS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, SETTINGS);
}
// SessionStart only runs `command` hooks in current Claude Code, so it gets a tiny forwarder script instead.
const COMMAND_EVENTS = ['SessionStart'];
const FORWARDER = path.join(DIR, 'forward-hook.js');
const qArg = s => '"' + s + '"';
const forwarderCmd = () => `${qArg(NODE)} ${qArg(FORWARDER)}`;
const isOurHook = h => h && (
  (h.type === 'http' && typeof h.url === 'string' && /^http:\/\/(localhost|127\.0\.0\.1):\d+\/events$/.test(h.url) && h.url.endsWith(`:${PORT}/events`)) ||
  (h.type === 'command' && typeof h.command === 'string' && h.command.includes('forward-hook.js')));
const hookFor = ev => COMMAND_EVENTS.includes(ev)
  ? { type: 'command', command: forwarderCmd(), timeout: 3 }
  : { type: 'http', url: HOOK_URL, timeout: 2 };

function installHooks() {
  const s = readSettings();
  const backup = backupSettings();
  if (s.hooks != null && typeof s.hooks !== 'object') throw new Error('settings.hooks is not an object — refusing to touch it.');
  s.hooks = s.hooks || {};
  let added = 0;
  for (const ev of HOOK_EVENTS) {
    const groups = Array.isArray(s.hooks[ev]) ? s.hooks[ev] : (s.hooks[ev] = []);
    const want = hookFor(ev);
    const existing = groups.flatMap(g => (g && Array.isArray(g.hooks) ? g.hooks : [])).find(isOurHook);
    if (existing && existing.type === want.type) {
      if (want.command) existing.command = want.command; // refresh path if the folder moved
      continue;
    }
    if (existing) for (const g of groups) if (g && Array.isArray(g.hooks)) g.hooks = g.hooks.filter(h => h !== existing);
    const group = { hooks: [want] };
    if (ev === 'PostToolUse') group.matcher = '*';
    groups.push(group);
    added++;
    s.hooks[ev] = groups.filter(g => !g || !Array.isArray(g.hooks) || g.hooks.length);
  }
  writeSettings(s);
  log(`✓ Hooks: ${added ? `added for ${added} event(s)` : 'already present'} in ${SETTINGS}${backup ? `\n  backup: ${backup}` : ''}`);
}

function removeHooks() {
  if (!fs.existsSync(SETTINGS)) { log('• No settings.json — no hooks to remove'); return; }
  const s = readSettings();
  if (!s.hooks || typeof s.hooks !== 'object') { log('• No hooks in settings.json'); return; }
  const backup = backupSettings();
  let removed = 0;
  for (const ev of Object.keys(s.hooks)) {
    if (!Array.isArray(s.hooks[ev])) continue;
    s.hooks[ev] = s.hooks[ev].map(g => {
      if (!g || !Array.isArray(g.hooks)) return g;
      const before = g.hooks.length;
      g.hooks = g.hooks.filter(h => !isOurHook(h));
      removed += before - g.hooks.length;
      return g.hooks.length ? g : null;
    }).filter(Boolean);
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  writeSettings(s);
  log(`✓ Hooks: removed ${removed} dashboard hook(s) from ${SETTINGS}\n  backup: ${backup}`);
}

// ------------------------------------------------------------- CLAUDE.md
function addClaudeMd() {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  const cur = fs.existsSync(CLAUDE_MD) ? fs.readFileSync(CLAUDE_MD, 'utf8') : '';
  if (cur.includes(MD_LINE)) { log(`✓ CLAUDE.md: line already present (${CLAUDE_MD})`); return; }
  const sep = cur && !cur.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(CLAUDE_MD, cur + sep + (cur ? '\n' : '') + MD_LINE + '\n');
  log(`✓ CLAUDE.md: ${cur ? 'appended line to' : 'created'} ${CLAUDE_MD}`);
}
function removeClaudeMd() {
  if (!fs.existsSync(CLAUDE_MD)) return;
  const cur = fs.readFileSync(CLAUDE_MD, 'utf8');
  if (!cur.includes(MD_LINE)) return;
  const next = cur.split('\n').filter(l => l.trim() !== MD_LINE).join('\n').replace(/\n{3,}/g, '\n\n');
  if (!next.trim()) fs.unlinkSync(CLAUDE_MD); else fs.writeFileSync(CLAUDE_MD, next);
  log(`✓ CLAUDE.md: removed the task-list line`);
}

// ------------------------------------------------------------- autostart
const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist');
const unitPath = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', 'claude-agent-dashboard.service');
const vbsPath = () => path.join(DIR, 'start-hidden.vbs');
const xmlEsc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function installAutostart() {
  const p = process.platform;
  if (p === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xmlEsc(NODE)}</string><string>${xmlEsc(SERVER)}</string></array>
  <key>WorkingDirectory</key><string>${xmlEsc(DIR)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEsc(LOG_FILE)}</string>
  <key>StandardErrorPath</key><string>${xmlEsc(LOG_FILE)}</string>
</dict></plist>
`;
    stopServer(true);
    fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
    fs.writeFileSync(plistPath(), plist);
    const uid = process.getuid();
    run('launchctl', ['bootout', `gui/${uid}`, plistPath()]);
    let r = run('launchctl', ['bootstrap', `gui/${uid}`, plistPath()]);
    if (!r.ok) r = run('launchctl', ['load', '-w', plistPath()]);
    log(r.ok ? `✓ Autostart: launchd agent ${plistPath()} (starts at login, restarts if it crashes)` : `! launchd load failed: ${r.out.trim()}`);
    return r.ok;
  }
  if (p === 'linux') {
    if (!run('systemctl', ['--user', 'show-environment']).ok) {
      log('! systemd --user not available; autostart not configured. Start manually with: node install.js start');
      return false;
    }
    const unit = `[Unit]
Description=Claude Agent Dashboard (http://localhost:${PORT})
After=network.target

[Service]
ExecStart="${NODE}" "${SERVER}"
WorkingDirectory=${DIR}
Restart=on-failure
RestartSec=3
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=default.target
`;
    stopServer(true);
    fs.mkdirSync(path.dirname(unitPath()), { recursive: true });
    fs.writeFileSync(unitPath(), unit);
    run('systemctl', ['--user', 'daemon-reload']);
    const r = run('systemctl', ['--user', 'enable', '--now', 'claude-agent-dashboard.service']);
    // Linger lets the user service start at boot, before you log in. Harmless if it fails.
    const linger = run('loginctl', ['enable-linger', os.userInfo().username]);
    log(r.ok ? `✓ Autostart: systemd user service ${unitPath()}${linger.ok ? ' (starts at boot)' : ' (starts at login)'}` : `! systemctl enable failed: ${r.out.trim()}`);
    return r.ok;
  }
  if (p === 'win32') {
    const q = s => '""' + s + '""';
    fs.writeFileSync(vbsPath(), `Set sh = CreateObject("WScript.Shell")\r\nsh.CurrentDirectory = "${DIR}"\r\nsh.Run "${q(NODE)} ${q(SERVER)}", 0, False\r\n`);
    const tr = `wscript.exe "${vbsPath()}"`;
    const r = run('schtasks', ['/Create', '/TN', WIN_TASK, '/SC', 'ONLOGON', '/TR', tr, '/RL', 'LIMITED', '/F']);
    if (r.ok) { stopServer(true); run('schtasks', ['/Run', '/TN', WIN_TASK]); }
    log(r.ok ? `✓ Autostart: Task Scheduler task "${WIN_TASK}" (runs hidden at logon)` : `! schtasks failed: ${r.out.trim()}`);
    return r.ok;
  }
  log(`! Unsupported platform ${p}; autostart not configured.`);
  return false;
}

function removeAutostart() {
  const p = process.platform;
  if (p === 'darwin' && fs.existsSync(plistPath())) {
    run('launchctl', ['bootout', `gui/${process.getuid()}`, plistPath()]);
    run('launchctl', ['unload', '-w', plistPath()]);
    fs.unlinkSync(plistPath());
    log('✓ Autostart: launchd agent removed');
  } else if (p === 'linux' && fs.existsSync(unitPath())) {
    run('systemctl', ['--user', 'disable', '--now', 'claude-agent-dashboard.service']);
    fs.unlinkSync(unitPath());
    run('systemctl', ['--user', 'daemon-reload']);
    log('✓ Autostart: systemd user service removed');
  } else if (p === 'win32') {
    const r = run('schtasks', ['/Delete', '/TN', WIN_TASK, '/F']);
    if (fs.existsSync(vbsPath())) fs.unlinkSync(vbsPath());
    if (r.ok) log('✓ Autostart: scheduled task removed');
  }
}

// ------------------------------------------------------------- start / stop
function ping() {
  return new Promise(res => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/state', timeout: 1000 }, r => { r.resume(); res(r.statusCode === 200); });
    req.on('error', () => res(false)); req.on('timeout', () => { req.destroy(); res(false); });
  });
}
function startDetached() {
  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(NODE, [SERVER], { cwd: DIR, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
}
function stopServer(quiet) {
  // Prefer the service manager if one owns the process (otherwise it would just restart it).
  if (process.platform === 'darwin' && fs.existsSync(plistPath())) { run('launchctl', ['bootout', `gui/${process.getuid()}`, plistPath()]); }
  if (process.platform === 'linux' && fs.existsSync(unitPath())) { run('systemctl', ['--user', 'stop', 'claude-agent-dashboard.service']); }
  if (process.platform === 'win32') run('schtasks', ['/End', '/TN', WIN_TASK]);
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
    if (pid) { process.kill(pid, 'SIGTERM'); if (!quiet) log(`✓ Stopped server (pid ${pid})`); }
  } catch (_) { if (!quiet) log('• Server was not running (no live pid)'); }
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
}
async function waitUp(ms) { const end = Date.now() + ms; while (Date.now() < end) { if (await ping()) return true; await new Promise(r => setTimeout(r, 250)); } return false; }

async function start() {
  if (await ping()) { log(`✓ Server already running on http://localhost:${PORT}`); return; }
  if (process.platform === 'darwin' && fs.existsSync(plistPath())) run('launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath()]);
  else if (process.platform === 'linux' && fs.existsSync(unitPath())) run('systemctl', ['--user', 'start', 'claude-agent-dashboard.service']);
  else if (process.platform === 'win32' && run('schtasks', ['/Query', '/TN', WIN_TASK]).ok) run('schtasks', ['/Run', '/TN', WIN_TASK]);
  if (!(await waitUp(3000))) startDetached();
  log((await waitUp(5000)) ? `✓ Server running on http://localhost:${PORT}` : `! Server did not come up — see ${LOG_FILE}`);
}

// ------------------------------------------------------------- main
(async () => {
  try {
    if (cmd === 'install') {
      log(`Installing Claude Agent Dashboard from ${DIR}\n`);
      if (!flag('--no-hooks')) installHooks();
      if (!flag('--no-claude-md')) addClaudeMd();
      if (!flag('--no-autostart')) installAutostart();
      await start();
      log(`\nOpen http://localhost:${PORT}  — new Claude Code sessions will appear automatically.`);
      log('Sessions that were already running pick up the hooks once restarted.');
    } else if (cmd === 'uninstall') {
      removeHooks();
      removeClaudeMd();
      removeAutostart();
      stopServer(false);
      log(`\nDone. Data files (state.json, events.jsonl, server.log) are still in ${DIR} — delete the folder to remove everything.`);
    } else if (cmd === 'start') { await start(); }
    else if (cmd === 'stop') { stopServer(false); }
    else if (cmd === 'status') { log((await ping()) ? `running on http://localhost:${PORT}` : 'not running'); }
    else { log('usage: node install.js [install|uninstall|start|stop|status] [--no-hooks] [--no-claude-md] [--no-autostart]'); process.exit(1); }
  } catch (e) { console.error('✗ ' + e.message); process.exit(1); }
})();
