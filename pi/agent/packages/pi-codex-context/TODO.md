# TODO

Completed compatibility-driver work is recorded here so the remaining gaps are explicit.

## P0: correctness

- [x] Preserve the logical window when `/tree` targets an entry carried across an automatic rollover.
  - Added a persisted tree re-anchor record. It references the existing logical window, carries the original target parent, and does not append a new window.
  - Projection and history assignment handle carried user messages, assistant tool calls, and tool results, including user selection where Pi branches to the parent.
  - Regression coverage exercises overflow and threshold rollover targets for all three entry kinds, including a later rollover, reopen, and repeat navigation of the same carried batch.

- [x] Fix `history_read` character pagination after UTF-8 output truncation.
  - The next offset is now based on the exact Unicode-character length emitted after the 40,000-byte item cap.
  - Regression coverage reads 20,000 emoji code points until the exact source is reconstructed.

## P1: tree and branch semantics

- [x] Add an automated `/tree` regression matrix.
  - Direct navigation covers explicit markers, carried user/tool-call/tool-result entries, branch re-anchoring, contiguous window state without creating logical duplicates, and the pre-seed reset-to-root leaf/next-append behavior.
  - Notes and history retain Pi's active-lineage behavior; regression coverage checks abandoned data is hidden until navigating back to that branch.

- [x] Preserve Pi's `/tree` summarization decision.
  - The extension does not intercept `session_before_tree`, so Pi's native summary is retained when `summarize: true`; a regression test verifies one native summarizer call and one `branch_summary` entry.
  - `summarize: false` remains the no-summary navigation contract. Rollover and `new_context` still use no summary.

- [x] Define the seed and leaf limitation.
  - Seeds and re-anchors are hidden from normal model projection, but append-only `appendEntry` can advance Pi's selected leaf when navigation lands before a seed or when state must be persisted.
  - A pre-seed reset-to-root fixture pins the native `newLeafId`, returned editor text, and next append parent. Exact selected-leaf preservation requires a native hidden-state/leaf operation.
  - Event-shape assertions are intentionally not treated as transport coverage: the harness uses in-process extension factories, while a missing `type` report would need a JSON-RPC serialization-boundary fixture.

- [x] Keep history and notes active-lineage-only.
  - This matches Pi's `getBranch()` and context projection. All-tree search is an explicit future scope, not a silent default change.

## P1: rollover lifecycle

- [x] Make explicit rollover recoverable across process death.
  - `new_context` now persists a prepare record before its tool result. Session start and `/tree` recovery commit it only when the matching successful result is present.
  - Incomplete prepares are inert, and recovery is idempotent.

- [ ] Force compaction for sessions Pi considers too small to prepare.
  - Blocked by the public API: installed Pi 0.85.1 runs `prepareCompaction()` before `session_before_compact` (`dist/core/agent-session.js:1486-1494` for manual and `:1749-1752` for automatic compaction) and returns without the hook when preparation is `undefined`. No repository hook can force this path without faking an unavailable API.
  - README no longer claims that every manual `/compact` creates a fresh window.

- [x] Validate owned markers and compaction records fail-closed on load.
  - Validation now covers strict variants, allowed reasons, non-empty and related IDs, parent ordering, carry relationships, continuous window predecessors per tree path, anchor/compaction correspondence, reset prepares, and foreign compaction providers. It intentionally scans the persisted tree before projection; disjoint seeds can exist when append-only tree navigation must seed a pre-seed root.
  - It runs at session start, tree navigation, compaction success, and compaction failure. Pi added `session_compact_failed` in 0.84.3; the package is tested and declared for `>=0.85.1`, while older versions such as `0.82.1` do not emit it. Malformed state produces fatal context output.

- [x] Handle cancellation and partial persistence safely.
  - Deterministic coverage aborts before tool execution, between a reset prepare and tool-result persistence, after a successful explicit tool result, and through the automatic-compaction signal. Incomplete prepares and anchors remain inert; reopen recovery creates no duplicate window or transcript leak.
  - Persisted explicit prepares recover only after a successful matching result, and recovery is idempotent.
  - Atomic anchor-plus-compaction persistence remains unavailable through Pi's append-only API.

## P1: extension composition

- [x] Define context-hook composition.
  - Load this extension after hooks that only add synthetic custom messages. Ordinary earlier-hook transformations cannot be losslessly reconstructed after a boundary because Pi exposes no stable context-message identity; heuristic matching is intentionally not used. Regression coverage is limited to the supported synthetic `before_agent_start` contract.

- [x] Test the single-compaction-owner invariant.
  - A foreign compaction after a managed seed now produces fatal context output without the old transcript.

## P2: accounting and bounded work

- [x] Replace the duplicated static overhead constants.
  - A bounded cache estimates the effective system prompt and active tool definitions by model/configuration, with a conservative 12,000-token fallback only when those inputs are unavailable and Pi-reported usage preferred when valid.
  - Provider-exact tokenization and authoritative pre-response usage remain unavailable through the public extension API.

- [x] Bound history image responses.
  - `history_read` now includes attached images in the existing 48,000-byte response budget, preserves readable text, and reports `images_omitted` when attached images do not fit.

- [x] Establish replay/index targets and bound replay work.
  - Deterministic benchmark workload targets: small <=1,000 entries/<=10 windows/<=100 note records/<=1 MB serialized; medium <=10,000/<=100/<=1,000/<=10 MB; large <=100,000/<=200/<=10,000/<=50 MB.
  - One local diagnostic run measured 959 entries/0.23 MB (small), 9,599/2.34 MB (medium), and 99,499/24.19 MB (large). Validation/project/history/note replay measured 1.27/0.30/0.63/0.30 ms, 10.08/0.86/2.43/0.90 ms, and 96.88/8.37/28.44/10.93 ms respectively; timings are diagnostics, not test gates.
  - Deterministic checks assert indexed results remain valid, scan counts equal session entries, note-record counts are exact, and chunk aggregation copies only the final 10,000-note/1,000,000-byte result rather than prior append prefixes. Validation uses a per-call by-id/index and ancestry interval index; notes use chunked aggregation. No broad history index or persisted snapshot is justified by these measurements.

- [x] Decide remaining Codex parity gaps.
  - `history_list_agents` remains current-session-only, `tool_namespace` remains `null`, and notes remain limited to 1,000,000 UTF-8 bytes per file. Pi provides no multi-agent registry or namespace metadata, and no task-level aggregate note limit was specified.

## Upstream Pi patch seam

- [ ] Replace `window-driver.ts` with a native persisted context-window operation when Pi exposes one.
  - Blocked with current public APIs: Pi exposes append-only custom entries, context replacement, post-preparation compaction hooks, and tree events, but no atomic operation that persists the boundary, rebuilds agent/provider state, resets authoritative usage/cache accounting, preserves pending input, and keeps the selected leaf unchanged.
  - References: earendil-works/pi#8972, earendil-works/pi#5461, openai/codex#27488.
