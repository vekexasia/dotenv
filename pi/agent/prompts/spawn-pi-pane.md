---
name: spawn-pi-pane
description: Split a herdr pane and launch a new pi instance with the same model as the current session, passing a task prompt via CLI.
argument-hint: "<task for the spawned agent>"
---

Spawn a sibling pi agent in a new herdr pane running the same model as this session, and hand it this task:

> $ARGUMENTS

If the task above is empty, ask the user what the spawned agent should do before proceeding. Expand the task into a self-contained prompt (step 3) — the spawned agent has no memory of this conversation, so include repo path, relevant file names, and verification commands.

Steps (all verified gotchas included):

1. Confirm `HERDR_ENV=1`. Your own pane id is `$HERDR_PANE_ID`.

2. Detect the current model. It is NOT in env vars — read it from this session's JSONL, which `herdr pane list` exposes as `agent_session.value` for your pane:
   ```bash
   session=$(herdr pane list | python3 -c 'import sys,json,os; ps=json.load(sys.stdin)["result"]["panes"]; print(next(p["agent_session"]["value"] for p in ps if p["pane_id"]==os.environ["HERDR_PANE_ID"]))')
   model=$(tac "$session" | grep -m1 -o '"model":"[^"]*"' | cut -d'"' -f4)
   provider=$(tac "$session" | grep -m1 -o '"provider":"[^"]*"' | cut -d'"' -f4)
   thinking=$(tac "$session" | grep -m1 -o '"thinkingLevel":"[^"]*"' | cut -d'"' -f4)
   ```

3. Write the task prompt to a temp file. Do not inline it in `herdr pane run` — nested quoting breaks on backticks, `$`, and newlines:
   ```bash
   cat > /tmp/spawn-prompt.txt <<'EOF'
   <expanded, self-contained task prompt here>
   EOF
   ```

4. Split (down or right) without stealing focus, parse the new pane id, launch:
   ```bash
   NEW_PANE=$(herdr pane split "$HERDR_PANE_ID" --direction down --no-focus | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
   herdr pane run "$NEW_PANE" "cd $(pwd) && pi --provider $provider --model $model:$thinking \"\$(cat /tmp/spawn-prompt.txt)\""
   ```
   Notes: the prompt is a positional arg to pi; thinking level attaches to the model as `model:level`; escape `\$(cat ...)` so it expands in the new pane's shell, not yours.

5. Verify it started: `sleep 5; herdr pane read "$NEW_PANE" --source recent --lines 30`. Then monitor with `herdr wait agent-status "$NEW_PANE" --status done --timeout 600000` or periodic `pane read` — never sleep-poll blindly.
