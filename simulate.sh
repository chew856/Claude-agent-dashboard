#!/usr/bin/env bash
# Sends simulated Claude Code hook events: 3 fake projects, 6 agents at different progress levels.
# Usage: ./simulate.sh [port]     (fake data clears itself: finished agents after 1h, others after 24h idle,
#                                  or click "Clear now" / restart with an empty state.json)
set -u
URL="http://localhost:${1:-4777}/events"
RUN=$RANDOM   # unique ids per run so repeated runs don't collide

post() { curl -s -o /dev/null -w '' -X POST -H 'Content-Type: application/json' --data "$1" "$URL" || { echo "Server not reachable at $URL"; exit 1; }; }
start()   { post "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$1\",\"cwd\":\"$2\",\"source\":\"startup\"}"; }
sub()     { post "{\"hook_event_name\":\"SubagentStart\",\"session_id\":\"$1\",\"cwd\":\"$2\",\"agent_id\":\"$3\",\"agent_type\":\"$4\"}"; }
# task SESSION CWD ID SUBJECT [AGENT_ID] — TaskCreated event + the matching PostToolUse(TaskCreate)
task() {
  local aid="${5:-}" extra=""
  [ -n "$aid" ] && extra=",\"agent_id\":\"$aid\""
  post "{\"hook_event_name\":\"TaskCreated\",\"session_id\":\"$1\",\"cwd\":\"$2\",\"task_id\":\"$3\",\"task_subject\":\"$4\"$extra}"
  post "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"$1\",\"cwd\":\"$2\"$extra,\"tool_name\":\"TaskCreate\",\"tool_input\":{\"subject\":\"$4\",\"description\":\"$4\"},\"tool_response\":{\"task\":{\"id\":\"$3\",\"subject\":\"$4\"}}}"
}
# upd SESSION CWD ID STATUS [AGENT_ID] — PostToolUse(TaskUpdate)
upd() {
  local extra=""; [ -n "${5:-}" ] && extra=",\"agent_id\":\"$5\""
  post "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"$1\",\"cwd\":\"$2\"$extra,\"tool_name\":\"TaskUpdate\",\"tool_input\":{\"taskId\":\"$3\",\"status\":\"$4\"},\"tool_response\":{\"success\":true}}"
}
# done SESSION CWD ID — TaskCompleted with NO agent_id (must still land on the agent that owns the task)
done_() { post "{\"hook_event_name\":\"TaskCompleted\",\"session_id\":\"$1\",\"cwd\":\"$2\",\"task_id\":\"$3\",\"task_subject\":\"x\"}"; }
tool() {
  local extra=""; [ -n "${5:-}" ] && extra=",\"agent_id\":\"$5\""
  post "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"$1\",\"cwd\":\"$2\"$extra,\"tool_name\":\"$3\",\"tool_input\":$4,\"tool_response\":{}}"
}

# ---- Project 1: webshop — main session 1/5 (20%), code-reviewer subagent 3/4 (75%)
S1="sim-webshop-$RUN"; C1="/Users/demo/code/webshop"; A1="sim-rev-$RUN"
start $S1 $C1
task $S1 $C1 1 "Set up checkout route"
task $S1 $C1 2 "Add Stripe payment form"
task $S1 $C1 3 "Validate cart totals"
task $S1 $C1 4 "Write checkout tests"
task $S1 $C1 5 "Update README"
upd $S1 $C1 1 in_progress; upd $S1 $C1 1 completed
upd $S1 $C1 2 in_progress
tool $S1 $C1 Edit "{\"file_path\":\"$C1/src/checkout/PaymentForm.tsx\"}"
sub $S1 $C1 $A1 code-reviewer
task $S1 $C1 6 "Review auth module" $A1
task $S1 $C1 7 "Review cart module" $A1
task $S1 $C1 8 "Review API handlers" $A1
task $S1 $C1 9 "Summarize findings" $A1
for t in 6 7 8; do upd $S1 $C1 $t in_progress $A1; done_ $S1 $C1 $t; done
upd $S1 $C1 9 in_progress $A1
tool $S1 $C1 Read "{\"file_path\":\"$C1/src/api/handlers.ts\"}" $A1

# ---- Project 2: api-gateway — main 3/8 with "+2 tasks added", test-runner subagent with no task list
S2="sim-api-$RUN"; C2="/Users/demo/code/api-gateway"; A2="sim-test-$RUN"
start $S2 $C2
for i in 1 2 3 4 5 6; do task $S2 $C2 $i "Migrate endpoint group $i to v2"; done
for i in 1 2 3; do upd $S2 $C2 $i in_progress; upd $S2 $C2 $i completed; done
task $S2 $C2 7 "Fix rate limiter regression"
task $S2 $C2 8 "Add deprecation headers"
upd $S2 $C2 4 in_progress
tool $S2 $C2 Bash '{"command":"npm test -- --grep v2","description":"Run v2 endpoint tests"}'
sub $S2 $C2 $A2 test-runner
tool $S2 $C2 Bash '{"command":"npx jest --runInBand","description":"Run full jest suite"}' $A2

# ---- Project 3: ml-pipeline — main 0/2 working on task 1, a general-purpose subagent that finished 3/3
S3="sim-ml-$RUN"; C3="/Users/demo/code/ml-pipeline"; A3="sim-gp-$RUN"
start $S3 $C3
task $S3 $C3 1 "Find all feature-flag reads"
task $S3 $C3 2 "Map flags to owners"
upd $S3 $C3 1 in_progress
tool $S3 $C3 Grep '{"pattern":"featureFlag(","path":"src"}'
sub $S3 $C3 $A3 general-purpose
task $S3 $C3 3 "Profile data loader" $A3
task $S3 $C3 4 "Cache tokenized dataset" $A3
task $S3 $C3 5 "Benchmark training step" $A3
for i in 3 4 5; do upd $S3 $C3 $i in_progress $A3; upd $S3 $C3 $i completed $A3; done
tool $S3 $C3 Write "{\"file_path\":\"$C3/BENCHMARK.md\"}" $A3
post "{\"hook_event_name\":\"SubagentStop\",\"session_id\":\"$S3\",\"cwd\":\"$C3\",\"agent_id\":\"$A3\",\"agent_type\":\"general-purpose\",\"last_assistant_message\":\"Loader is 3.1x faster with the token cache; results in BENCHMARK.md.\"}"

echo "Sent simulated events for 3 projects / 6 agents. Open http://localhost:${1:-4777}"
