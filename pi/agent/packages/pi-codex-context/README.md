# pi-codex-context

Codex-style experimental context management for stock Pi, without a Pi fork.

## Behavior

- Exposes the complete Codex tool surface:
  - `get_context_remaining`, `new_context`
  - `notes_write_file`, `notes_append_file`, `notes_read_file`, `notes_list_files`, `notes_search_contents`
  - `history_list_agents`, `history_list_windows`, `history_list_items`, `history_search_contents`, `history_read`
- `new_context` takes no handoff and must be called alone.
- A fresh `new_context` window receives no summary and no consumed transcript tail.
- Automatic rollover preserves only input that the model has not consumed yet, including an outstanding tool call/result batch.
- Notes and exact history stay in the append-only Pi session and follow its active branch.
- Repeated `new_context` calls create contiguous windows without a transcript handoff.
- `/tree` keeps Pi's native branch summarization when `summarize: true`; use `summarize: false` for navigation without a summary.
- If another compaction provider modifies a managed session, the extension fails closed instead of leaking an old window back into model context.

The extension stores no external database and makes no model call for rollover.

## Stock Pi driver and future core patch

`extensions/window-driver.ts` is the compatibility boundary. On stock Pi 0.85.1 it combines public custom session entries, the `context` projection hook, and `session_before_compact`. A future native `ctx.newContext()`/context-window API only needs to replace this driver; note/history tools are independent.

Upstream references for that future patch:

- https://github.com/earendil-works/pi/issues/8972
- https://github.com/earendil-works/pi/issues/5461
- https://github.com/openai/codex/pull/27488

This extension must be the sole compaction provider for a managed session. The package is tested and declared for Pi `>=0.85.1`; Pi added `session_compact_failed` in 0.84.3, while older versions such as `0.82.1` do not emit it. The test harness uses Pi `0.85.1` and does not exercise a separate out-of-process event serialization bridge.

## Compatibility limits

This driver uses append-only custom entries because stock Pi does not expose an atomic persisted context-window operation. Automatic rollover and manual `/compact` can create a fresh window only when Pi produces a compaction preparation and emits `session_before_compact`; short sessions that Pi considers too small are left unchanged. A native operation is required to force those cases and to make anchor plus compaction atomic.

History and notes intentionally use the active Pi lineage. Other branches become visible after navigating back to them; there is no implicit all-tree search. `history_list_agents` reports only the current session and history tool namespaces are `null`, because the public session entries do not provide multi-agent or namespace metadata. Notes are limited to 1,000,000 UTF-8 bytes per file. `history_read` keeps text within the tool response budget and reports `images_omitted` instead of returning oversized attached images.

Context accounting uses Pi-reported usage when it is valid. Before usage is available, it estimates the effective system prompt and active tool definitions once per model/configuration, falling back to a conservative 12,000-token estimate only when that data is unavailable. Provider-exact tokenization is not available through the extension API. Replay operations use an ephemeral by-id/ancestry index for validation and chunked note aggregation; no broad history index or persisted snapshot is used.

Context-hook ordering is a contract: load this extension after hooks that only add synthetic custom messages. Ordinary message transformations from an earlier hook cannot be losslessly mapped after a boundary because Pi exposes no stable context-message identity; arbitrary ordinary-message composition is unsupported.

When tree navigation lands before a window marker, the driver persists a hidden re-anchor state record. It uses the first historical rollover that consumed the target, so later descendant rollovers carrying the same batch do not change repeat navigation. Append-only Pi APIs can still change the selected leaf while persisting state, especially for a pre-seed or root selection.

## Development

```sh
npm install --ignore-scripts
npm run typecheck
npm test
npm run benchmark
```

Tests use Pi's real SDK/session/extension runner with a credential-free scripted provider. They cover the tool surface, contiguous explicit windows, active-lineage notes/history, Unicode history paging, bounded image responses, carried-entry tree re-anchoring, native `/tree` summarization, pre-seed leaf behavior, hook composition, effective accounting, automatic threshold rollover, abort/reopen recovery, explicit-reset recovery, overflow retry, compaction-failure poisoning, replay-index duplicate rejection, and malformed-state rejection. `npm run benchmark` checks deterministic small/medium/large replay workloads and prints diagnostic timings.
