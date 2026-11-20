# Claude Agent Dashboard

A live, local dashboard showing the progress of every Claude Code agent you have running: main sessions and subagents, across all projects.

- Zero npm dependencies. It needs only Node.js 18 or newer.
- Runs at **http://localhost:4777** and listens on loopback only.
- Progress is based on each agent's task list: completed ÷ total tasks.

## Install

```bash
git clone <this repo> ~/claude-agent-dashboard
cd ~/claude-agent-dashboard
node install.js
```

`node install.js` does four things:

1. **Hooks**: backs up `~/.claude/settings.json` to `settings.json.bak-<timestamp>`, then *merges* the dashboard's hooks into it. Your existing settings and hooks are kept, and re-running it won't add duplicates.
   - `SessionEnd`, `SubagentStart`, `SubagentStop`, `PostToolUse`, `TaskCreated`, `TaskCompleted` use `{ "type": "http", "url": "http://localhost:4777/events", "timeout": 2 }`.
   - `SessionStart` uses a **command** hook (`node forward-hook.js`) because Claude Code currently runs only command hooks for that event and skips HTTP ones without any error. The forwarder POSTs the same payload to the same endpoint and prints nothing.
2. **CLAUDE.md**: appends this line to `~/.claude/CLAUDE.md`, creating the file if needed: *"Always start work by writing a task list, and update each item's status as you finish it."*
3. **Autostart** for your OS:
   - macOS: launchd agent `~/Library/LaunchAgents/com.claude-agent-dashboard.plist`. Starts at login and restarts if it crashes.
   - Linux: systemd user service `~/.config/systemd/user/claude-agent-dashboard.service`. It also enables linger so the service starts at boot.
   - Windows: Task Scheduler task `ClaudeAgentDashboard`. Runs hidden at logon.
4. **Starts the server.**

Sessions that are already running only pick up the new hooks after a restart.

Flags: `--no-hooks`, `--no-claude-md`, `--no-autostart`.

## Cloud sessions (claude.ai/code, e.g. from an iPad)

Cloud sessions each run in their own container, so they can't reach a `localhost` dashboard. For them, host the server publicly and install the hooks with the cloud environment's setup script.

**1. Host the server.** Any platform that runs a long-lived Node process works. It needs no build step and no dependencies, and the start command is `npm start`. For example, on [Railway](https://railway.app), which can be set up from a browser: *New Project → Deploy from GitHub repo → this repo*. Then:
- Set the variable `DASHBOARD_TOKEN` to a long random string. With a token set, the server listens on the platform's `PORT`, and every request needs that token.
- Optional: add a volume and set `CLAUDE_DASHBOARD_DATA` to its mount path, so `state.json` survives redeploys.
- Generate a public domain, e.g. `https://xyz.up.railway.app`.

Avoid hosts that sleep when idle, such as Render's free tier. Hooks time out after 2 seconds, so events sent while the server wakes up are lost.

**2. Open it once on your iPad** at `https://<host>/?token=<DASHBOARD_TOKEN>`. That sets a 1-year cookie and removes the token from the address bar. Add it to your Home Screen if you like. `GET /healthz` is the only unauthenticated route.

**3. Install hooks in your cloud environment.** Open the environment settings (cloud environment menu → Edit):
- **Setup script**: paste `cloud-setup.sh`, with `DASH` set to your host. On each new session it merges the hooks into the container's `~/.claude/settings.json` and adds the CLAUDE.md line. SessionStart uses `curl` as a command hook, because that event doesn't run HTTP hooks.
- **Network secret** for your dashboard host: the `DASHBOARD_TOKEN` value, as a Bearer token. The session's proxy adds it to every request to that host, which also allows the host. The token never appears in the script or the hooks.
- Repeat this for each environment your agents use. Hooks take effect in sessions started after the change.

Hooks fail silently if the dashboard is down or the token is wrong. Agents keep working either way.

## Start / stop

```bash
node install.js start     # start (via the OS service if installed, else in the background)
node install.js stop      # stop
node install.js status
node server.js            # or run it in the foreground
```

If you move the folder, run `node install.js` again so the hook and service paths are updated.

## Try it with fake data

```bash
./simulate.sh
```

This sends simulated hook events for 3 projects and 6 agents (20%, 75%, 38% with "+2 tasks added", no task list, 0%, and one finished). Open http://localhost:4777. The fake cards clear on their own: finished ones after 1 hour, others after 24 hours with no events. You can also click **Clear now** in the Finished section.

## Uninstall

```bash
cd ~/claude-agent-dashboard
node install.js uninstall   # removes the hooks (after another backup), the CLAUDE.md line and autostart, and stops the server
rm -rf ~/claude-agent-dashboard
```

Uninstall removes only the dashboard's own hooks: HTTP hooks pointing at `localhost:4777/events` and the `forward-hook.js` command. Everything else in `settings.json` is left untouched.

## How it works

| Endpoint | Purpose |
|---|---|
| `POST /events` | Receives hook payloads. Always replies `200` with an empty body, before processing. |
| `GET /` | The dashboard (`index.html`, self-contained). |
| `GET /stream` | Server-Sent Events with a full snapshot after each change (throttled to 5 per second). |
| `GET /state` | The current snapshot as JSON, for debugging. |

- **One card per agent**, keyed by `agent_id` for subagents and by `session_id` for the main session.
- **Tasks** come from `TaskCreated`/`TaskCompleted`, from `PostToolUse` on `TaskCreate`/`TaskUpdate`, and from `TodoWrite` (older versions, which send the full list each time). A `session:task_id → agent` map makes sure a `TaskCompleted` event without `agent_id` lands on the agent that created the task.
- Real payload shapes, verified against Claude Code 2.1:
  - `TaskCreate` input is `{subject, description, activeForm?}` and the response is `{task: {id, subject, description}}`.
  - `TaskUpdate` input is `{taskId, status?, subject?, …}`, where status is `pending | in_progress | completed | deleted`.
  - Task IDs are unique within a session, including across its subagents.
- **Status**:
  - *running*
  - *idle*: no events for 5+ minutes.
  - *done*: after `SubagentStop`, or after `SessionEnd`, which also finishes that session's subagents.
- Finished cards move to a collapsible **Finished** section and are removed after 1 hour.
- **Persistence**: state is saved to `state.json` every 3 seconds, and on shutdown.
- **Debug log**: every raw event is appended to `events.jsonl`. It rotates to `events.1.jsonl` at 50 MB.
- Environment overrides: `CLAUDE_DASHBOARD_PORT` (or `PORT`), `CLAUDE_DASHBOARD_DATA` (the data directory), and `DASHBOARD_TOKEN` (hosted mode: listen on all interfaces and require the token). `CLAUDE_CONFIG_DIR` is respected by the installer.

## Files

| File | |
|---|---|
| `server.js` | the server |
| `index.html` | the page |
| `install.js` | install / uninstall / start / stop |
| `forward-hook.js` | SessionStart forwarder |
| `simulate.sh` | fake events (`./simulate.sh` uses localhost; edit `URL` for a hosted server) |
| `cloud-setup.sh` | setup script for cloud environments |
| `package.json` | start script for hosting platforms (no dependencies) |
| `state.json`, `events.jsonl`, `server.log` | runtime data (git-ignored) |
