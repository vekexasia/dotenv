# TODO

Known work for the stock-Pi compatibility driver. Ordered by impact.

## P0: correctness

- [ ] Preserve the logical window when `/tree` targets an entry carried across an automatic rollover.
  - Confirmed: after overflow recovery, selecting the carried user entry changed the active state from window 2 back to window 1.
  - Cause: the append-only marker is physically after `carryStartId`; branching at the carried entry excludes the marker that retroactively assigns it to the new window.
  - Cover carried user messages, assistant tool calls, and tool results.
  - Done when editing or branching from any carried entry remains in the window that originally consumed it.

- [ ] Fix `history_read` character pagination after UTF-8 output truncation.
  - Confirmed with 20,000 emoji characters: only 9,999 were returned, `content_truncated` was true, but `next_offset_chars` was null.
  - Cause: `history_read` computes the next offset before `publicItem()` applies the byte cap.
  - Done when concatenating paged reads reproduces the exact original Unicode content without gaps or duplicates.

## P1: tree and branch semantics

- [ ] Add an automated `/tree` regression matrix.
  - Navigate backward and forward across explicit windows.
  - Select assistant, user, boundary, carried-user, tool-call, and tool-result entries.
  - Exercise contiguous empty windows.
  - Verify note and history visibility on both the active and abandoned branches.
  - The ordinary assistant-entry path has only an ad hoc SDK smoke test today.

- [ ] Decide and document `/tree` summarization behavior.
  - Pi's `session_before_tree` path is currently untouched.
  - `/tree` with summarization can call the normal model summarizer and inject an abandoned-branch summary into the selected window.
  - Choose between preserving this explicit Pi behavior and replacing it with a no-summary branch operation.

- [ ] Avoid changing the leaf invisibly when navigation lands before the branch's seed marker.
  - `session_tree` currently calls `ensureSeed()`, which appends a child after Pi has already emitted its selected `newLeafId`.
  - Verify tree UI selection, returned editor text, event IDs, and the next append position.

- [ ] Decide whether history and notes remain active-lineage-only.
  - `history_*` and `notes_*` read `sessionManager.getBranch()`.
  - Abandoned branches remain in the session file but are not searchable until the user navigates back to them.
  - Codex-style parity may require all-tree or explicit branch scope without changing default lineage behavior.

## P1: rollover lifecycle

- [ ] Make explicit rollover recoverable across process death.
  - The successful `new_context` tool result is persisted before the boundary is committed in `turn_end`.
  - A crash in that interval leaves a successful reset result with no reset marker.
  - Add a persisted prepare/commit transaction or replace it with a native atomic Pi operation.

- [ ] Handle compaction triggers for sessions Pi considers too small to prepare.
  - Confirmed: high provider usage with a short transcript can cross the threshold while `prepareCompaction()` returns undefined, so `session_before_compact` never fires.
  - Small-session `/compact` can likewise fail before the extension sees it.
  - Correct the README claim that every `/compact` becomes a fresh window until this is handled.

- [ ] Validate every owned marker and compaction record fail-closed on load.
  - Current parsing accepts broad string fields and silently skips malformed or broken-chain markers.
  - A damaged committed marker can fall back to an older boundary and expose an earlier window.
  - Validate reason values, required fields by variant, ID relationships, and malformed owned entries during `session_start` and `session_tree`.

- [ ] Test cancellation and partial persistence boundaries.
  - Abort before tool execution, during tool execution, after tool result, during automatic compaction, and after anchor append.
  - Verify no dangling committed window, duplicate rollover, or transcript leak after reload.

## P1: extension composition

- [ ] Define context-hook composition instead of reconstructing all ordinary messages.
  - After a boundary, this extension preserves synthetic `custom` messages from earlier hooks but rebuilds user, assistant, and tool messages from session entries.
  - Any earlier extension transformation to an ordinary message is therefore lost.
  - Add a harness with context hooks both before and after this extension.

- [ ] Keep the single-compaction-owner invariant tested.
  - VCC is now disabled because Pi uses the last non-cancelling `session_before_compact` result.
  - Add a negative test proving a foreign compaction after the managed seed causes fail-closed output and no old-context leak.

## P2: accounting and bounded work

- [ ] Replace the hard-coded 12,000-token static overhead estimate.
  - Before the first assistant response in a window, `get_context_remaining` and materialization decisions do not count the actual system prompt and active tool schemas.
  - Use a public Pi estimator when available; otherwise measure the effective prompt and tool definitions once per relevant configuration.

- [ ] Bound and index session replay work.
  - Every history query rebuilds normalized items from the full active branch.
  - Every note operation replays all note events; many small appends repeatedly rebuild strings.
  - Large images are replayed by `history_read` without an explicit aggregate image-byte/count budget.
  - Establish measured session-size and latency targets before adding an index or snapshot format.

- [ ] Decide remaining Codex parity gaps.
  - `history_list_agents` exposes only the current Pi session.
  - `tool_namespace` is always null, so namespace filters cannot match.
  - Notes have a 1 MB per-file limit but no task-level file-count or total-byte limit.

## Upstream Pi patch seam

- [ ] Replace `window-driver.ts` with a native persisted context-window operation when Pi exposes one.
  - The native boundary must rebuild `agent.state` immediately, release the previous provider view, reset authoritative usage/cache accounting, preserve pending input in order, and commit atomically.
  - Automatic rollover must be claimable before summarization authentication and before `prepareCompaction()`.
  - Keep the note/history tool contracts independent of the native driver.
  - References: earendil-works/pi#8972, earendil-works/pi#5461, openai/codex#27488.
