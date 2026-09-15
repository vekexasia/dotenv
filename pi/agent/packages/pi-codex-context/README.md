# pi-codex-context

Codex-style experimental context management for stock Pi, without a Pi fork.

## Behavior

- Exposes the complete Codex tool surface:
  - `get_context_remaining`, `new_context`
  - `notes_write_file`, `notes_append_file`, `notes_read_file`, `notes_list_files`, `notes_search_contents`
  - `history_list_agents`, `history_list_windows`, `history_list_items`, `history_search_contents`, `history_read`
- `new_context` takes no handoff and must be called alone.
- A fresh window receives no summary and no consumed transcript tail.
- Automatic rollover preserves only input that the model has not consumed yet, including an outstanding tool call/result batch.
- Notes and exact history stay in the append-only Pi session and follow its active branch.
- Repeated `new_context` calls create contiguous empty windows.
- If another compaction provider modifies a managed session, the extension fails closed instead of leaking an old window back into model context.

The extension stores no external database and makes no model call for rollover.

## Stock Pi driver and future core patch

`extensions/window-driver.ts` is the compatibility boundary. On stock Pi 0.85.1 it combines public custom session entries, the `context` projection hook, and `session_before_compact`. A future native `ctx.newContext()`/context-window API only needs to replace this driver; note/history tools are independent.

Upstream references for that future patch:

- https://github.com/earendil-works/pi/issues/8972
- https://github.com/earendil-works/pi/issues/5461
- https://github.com/openai/codex/pull/27488

This extension must be the sole compaction provider for a managed session.

## Development

```sh
npm install --ignore-scripts
npm run typecheck
npm test
```

Tests use Pi's real SDK/session/extension runner with a credential-free scripted provider. They cover the tool surface, contiguous explicit windows, notes/history recovery, automatic threshold rollover, unseen tool-result carry, overflow retry, and mixed-call rejection.
