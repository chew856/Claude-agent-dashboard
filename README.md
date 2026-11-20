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
- Environment overrides: `CLAUDE_DASHBOARD_PORT` and `CLAUDE_DASHBOARD_DATA` (the data directory). `CLAUDE_CONFIG_DIR` is respected by the installer.

## Files

| File | |
|---|---|
| `server.js` | the server |
| `index.html` | the page |
| `install.js` | install / uninstall / start / stop |
| `forward-hook.js` | SessionStart forwarder |
| `simulate.sh` | fake events |
| `state.json`, `events.jsonl`, `server.log` | runtime data (git-ignored) |
