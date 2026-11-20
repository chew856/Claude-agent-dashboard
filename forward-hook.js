#!/usr/bin/env node
// Command-hook forwarder: reads a Claude Code hook payload on stdin and POSTs it to the dashboard.
// Used for SessionStart, which (in current Claude Code) only runs `command` hooks, not `http` hooks.
// Must print NOTHING to stdout (SessionStart stdout is added to Claude's context) and always exit 0.
'use strict';
const http = require('http');
const PORT = Number(process.env.CLAUDE_DASHBOARD_PORT) || 4777;
const chunks = [];
const done = () => process.exit(0);
setTimeout(done, 1500).unref();
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('error', done);
process.stdin.on('end', () => {
  const body = Buffer.concat(chunks);
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/events', method: 'POST', timeout: 1000,
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, res => { res.resume(); res.on('end', done); });
  req.on('error', done);
  req.on('timeout', () => { req.destroy(); done(); });
  req.end(body);
});
