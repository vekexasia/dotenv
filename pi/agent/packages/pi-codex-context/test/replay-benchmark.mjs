import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const store = await jiti.import(new URL("../extensions/store.ts", import.meta.url).pathname);
const windowDriver = await jiti.import(new URL("../extensions/window-driver.ts", import.meta.url).pathname);

const cases = [
  { name: "small", cycles: 280, windows: 10, notes: 100, maxEntries: 1_000, maxBytes: 1_000_000 },
  { name: "medium", cycles: 2_800, windows: 100, notes: 1_000, maxEntries: 10_000, maxBytes: 10_000_000 },
  { name: "large", cycles: 29_700, windows: 200, notes: 10_000, maxEntries: 100_000, maxBytes: 50_000_000 },
];

function user(index) {
  return { role: "user", content: [{ type: "text", text: `request ${index}` }] };
}

function assistant(index) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: `call-${index}`, name: "notes_list_files", arguments: {} }],
    stopReason: "toolUse",
    provider: "test",
    model: "replay-benchmark",
  };
}

function toolResult(index) {
  return {
    role: "toolResult",
    toolCallId: `call-${index}`,
    toolName: "notes_list_files",
    content: [{ type: "text", text: `result ${index}` }],
    isError: false,
  };
}

function makeSession(spec) {
  const manager = SessionManager.inMemory("/replay-benchmark");
  const firstWindowId = `${spec.name}-window-0`;
  manager.appendCustomEntry(store.WINDOW_ENTRY, {
    version: 1,
    kind: "seed",
    firstWindowId,
    windowId: firstWindowId,
  });
  const anchorCycles = new Set(Array.from({ length: spec.windows - 1 }, (_, index) =>
    Math.floor(((index + 1) * spec.cycles) / (spec.windows - 1)) - 1,
  ));
  let previousWindowId = firstWindowId;
  for (let index = 0; index < spec.cycles; index++) {
    manager.appendMessage(user(index));
    manager.appendMessage(assistant(index));
    manager.appendMessage(toolResult(index));
    if (!anchorCycles.has(index)) continue;
    const windowId = `${spec.name}-window-${index}`;
    const txId = `${spec.name}-tx-${index}`;
    const anchorId = manager.appendCustomEntry(store.WINDOW_ENTRY, {
      version: 1,
      kind: "anchor",
      firstWindowId,
      previousWindowId,
      windowId,
      reason: "threshold",
      txId,
    });
    manager.appendCompaction(`checkpoint ${index}`, anchorId, 0, {
      owner: store.OWNER,
      version: 1,
      kind: "rollover",
      txId,
      boundaryId: anchorId,
      firstWindowId,
      previousWindowId,
      windowId,
    });
    previousWindowId = windowId;
  }
  for (let index = 0; index < spec.notes; index++) {
    manager.appendCustomEntry(store.NOTE_ENTRY, {
      version: 1,
      op: "append",
      path: "benchmark.log",
      text: "x".repeat(100),
    });
  }
  return manager;
}

function timed(fn) {
  const started = performance.now();
  const value = fn();
  return { value, milliseconds: performance.now() - started };
}

for (const spec of cases) {
  const manager = makeSession(spec);
  const entries = manager.getEntries();
  const serializedBytes = Buffer.byteLength(JSON.stringify(entries));
  assert.ok(entries.length <= spec.maxEntries, `${spec.name}: entry target exceeded`);
  assert.ok(serializedBytes <= spec.maxBytes, `${spec.name}: serialized target exceeded`);

  const validation = timed(() => windowDriver.validateOwnedCompactions(entries));
  assert.equal(validation.value, undefined, `${spec.name}: validation failed`);
  const stateResult = timed(() => store.deriveWindowState(entries));
  assert.equal(stateResult.value.windows.length, spec.windows, `${spec.name}: window target mismatch`);
  const projectionResult = timed(() => windowDriver.projectedMessages(manager, stateResult.value));
  const historyResult = timed(() => store.historyItems(entries, stateResult.value));
  const notesResult = timed(() => store.readNotes(entries));
  assert.equal(historyResult.value.length, spec.cycles * 3);
  const referenceEntries = entries.map((entry) => structuredClone(entry));
  const referenceState = store.deriveWindowState(referenceEntries);
  const referenceHistory = store.historyItems(referenceEntries, referenceState);
  const referenceNotes = store.readNotes(referenceEntries);
  const indexedResults = {
    state: stateResult.value,
    projection: projectionResult.value,
    history: historyResult.value,
    notes: notesResult.value,
  };
  const pureResults = {
    state: referenceState,
    projection: store.currentWindowEntries(manager.buildContextEntries(), referenceState).flatMap(store.entryToMessages),
    history: referenceHistory,
    notes: referenceNotes,
  };
  assert.deepEqual(indexedResults, pureResults, `${spec.name}: indexed replay differs from pure replay`);

  const index = store.buildReplayIndex(entries, { notes: true, ancestors: true });
  assert.equal(index.duplicateEntryIds.length, 0);
  assert.equal(index.counters.entriesScanned, entries.length);
  assert.equal(index.noteRecords.length, spec.notes);
  const indexedNotes = store.readNotesIndexed(index);
  assert.deepEqual(indexedNotes, notesResult.value, `${spec.name}: indexed notes differ`);
  assert.equal(index.counters.noteRecordsScanned, spec.notes);
  assert.equal(index.counters.noteBytesCopied, 100 * spec.notes);
  assert.equal(index.counters.pathSteps, 0);

  console.log(JSON.stringify({
    name: spec.name,
    entries: entries.length,
    serialized_mb: Number((serializedBytes / 1_000_000).toFixed(2)),
    windows: stateResult.value.windows.length,
    note_records: spec.notes,
    validation_ms: Number(validation.milliseconds.toFixed(2)),
    project_ms: Number(projectionResult.milliseconds.toFixed(2)),
    history_ms: Number(historyResult.milliseconds.toFixed(2)),
    notes_ms: Number(notesResult.milliseconds.toFixed(2)),
    scan_entries: index.counters.entriesScanned,
    scan_note_records: index.counters.noteRecordsScanned,
    copied_note_bytes: index.counters.noteBytesCopied,
  }));
}
