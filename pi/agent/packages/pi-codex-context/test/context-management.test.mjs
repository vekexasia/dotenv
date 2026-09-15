import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createHarness, overflow, reply, requestText, toolCall, toolCalls } from "./harness.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const store = await jiti.import(new URL("../extensions/store.ts", import.meta.url).pathname);

const TOOL_NAMES = [
  "get_context_remaining",
  "new_context",
  "notes_write_file",
  "notes_append_file",
  "notes_read_file",
  "notes_list_files",
  "notes_search_contents",
  "history_list_agents",
  "history_list_windows",
  "history_list_items",
  "history_search_contents",
  "history_read",
];

async function withHarness(options, run) {
  const harness = await createHarness(options);
  try {
    await run(harness);
    assert.deepEqual(harness.extensionErrors, []);
    assert.deepEqual(harness.providerRequests, []);
  } finally {
    await harness.close();
  }
}

test("registers the complete Codex context tool surface", async () => {
  await withHarness({}, async ({ session }) => {
    const tools = session.getAllTools();
    assert.deepEqual(tools.map((tool) => tool.name).filter((name) => TOOL_NAMES.includes(name)).sort(), [...TOOL_NAMES].sort());
    assert.deepEqual(session.getActiveToolNames().sort(), [...TOOL_NAMES].sort());
    assert.equal(tools.find((tool) => tool.name === "new_context").parameters.additionalProperties, false);
  });
});

test("supports contiguous explicit context windows with no transcript tail", async () => {
  await withHarness({}, async ({ manager, requests, responses, session }) => {
    responses.push(
      toolCall("new_context", {}, "reset-1"),
      toolCall("new_context", {}, "reset-2"),
      reply("done"),
    );
    await session.prompt("SECRET FROM FIRST WINDOW");

    assert.equal(requests.length, 3);
    assert.match(requestText(requests[0]), /SECRET FROM FIRST WINDOW/);
    assert.doesNotMatch(requestText(requests[1]), /SECRET FROM FIRST WINDOW|reset-1/);
    assert.doesNotMatch(requestText(requests[2]), /SECRET FROM FIRST WINDOW|reset-1|reset-2/);
    assert.match(requestText(requests[1]), /<context_window>/);
    assert.match(requestText(requests[2]), /<context_window>/);

    const state = store.deriveWindowState(manager.getBranch());
    assert.equal(state.windows.length, 3);
    assert.equal(state.currentWindowId, state.windows[2]);
  });
});

test("persists notes and retrieves exact prior-window history on demand", async () => {
  await withHarness({}, async ({ manager, requests, responses, session }) => {
    responses.push(
      toolCall("notes_write_file", { path: "state.md", text: "DURABLE STATE" }, "note-write"),
      toolCall("new_context", {}, "reset"),
      toolCall("history_search_contents", { query: "HISTORY SECRET" }, "history-search"),
      toolCall("notes_read_file", { path: "state.md" }, "note-read"),
      reply("done"),
    );
    await session.prompt("HISTORY SECRET");

    assert.equal(requests.length, 5);
    assert.doesNotMatch(requestText(requests[2]), /HISTORY SECRET|DURABLE STATE|note-write|reset/);
    assert.match(requestText(requests[3]), /HISTORY SECRET/);
    assert.match(requestText(requests[4]), /DURABLE STATE/);
    const notes = store.readNotes(manager.getBranch());
    assert.equal(notes.find((file) => file.path === "state.md").text, "DURABLE STATE");
  });
});

test("supports append, list, search, and ranged reads for notes", async () => {
  await withHarness({}, async ({ manager, requests, responses, session }) => {
    responses.push(
      toolCall("notes_append_file", { path: "log.txt", text: "first" }, "append-1"),
      toolCall("notes_append_file", { path: "log.txt", text: "\nsecond" }, "append-2"),
      toolCall("notes_list_files", { prefix: "log" }, "notes-list"),
      toolCall("notes_search_contents", { query: "second" }, "notes-search"),
      toolCall("notes_read_file", { path: "log.txt", line_start: -1, line_stop: -1 }, "notes-read"),
      reply("done"),
    );
    await session.prompt("exercise note tools");

    assert.equal(store.readNotes(manager.getBranch())[0].text, "first\nsecond");
    assert.match(requestText(requests[3]), /log\.txt/);
    assert.match(requestText(requests[4]), /second/);
    assert.match(requestText(requests[5]), /second/);
  });
});

test("lists, searches, and reads normalized history items", async () => {
  await withHarness({}, async ({ manager, requests, responses, session }) => {
    responses.push(
      toolCall("history_list_agents", {}, "agents"),
      toolCall("history_list_windows", {}, "windows"),
      toolCall("history_list_items", { limit: 1 }, "items"),
      toolCall("history_search_contents", { query: "HISTORY ITEM MARKER" }, "search"),
      reply("listed"),
    );
    await session.prompt("HISTORY ITEM MARKER");
    const listResult = manager.getBranch().find(
      (entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "items",
    );
    const itemId = listResult.message.details.items[0].item_id;

    responses.push(toolCall("history_read", { item_id: itemId, offset_chars: 0, limit_chars: 7 }, "read"), reply("done"));
    await session.prompt("read it");
    assert.match(requestText(requests.at(-1)), /HISTORY/);
  });
});

test("materializes a near-limit explicit reset without creating a duplicate logical window", async () => {
  await withHarness({ contextWindow: 80_000, reserveTokens: 1_000, keepRecentTokens: 100 }, async ({ manager, requests, responses, session }) => {
    responses.push(reply("X".repeat(1_000)));
    await session.prompt("OLD MATERIALIZED TURN");
    const reset = toolCall("new_context", {}, "near-limit-reset");
    reset.usage = { ...reset.usage, input: 79_000, output: 10, totalTokens: 79_010 };
    responses.push(reset, reply("continued"));
    await session.prompt("MATERIALIZE SECRET");

    const state = store.deriveWindowState(manager.getBranch());
    assert.equal(state.windows.length, 2);
    const compaction = manager.getBranch().findLast((entry) => entry.type === "compaction");
    assert.equal(compaction.details.kind, "materialize");
    assert.doesNotMatch(requestText(requests[2]), /OLD MATERIALIZED TURN|MATERIALIZE SECRET|near-limit-reset|was not summarized/);
  });
});

test("automatic rollover carries an unseen tool batch but no older transcript", async () => {
  await withHarness({ contextWindow: 80_000, reserveTokens: 1_000, keepRecentTokens: 100 }, async ({ requests, responses, session }) => {
    responses.push(reply("X".repeat(1_000)));
    await session.prompt("DROP THIS OLD USER MESSAGE");
    const call = toolCall("notes_list_files", {}, "unseen-tool-call");
    call.usage = { ...call.usage, input: 79_000, output: 10, totalTokens: 79_010 };
    responses.push(call, reply("consumed tool result"));
    await session.prompt("CURRENT TOOL REQUEST");

    assert.equal(requests.length, 3);
    assert.doesNotMatch(requestText(requests[2]), /DROP THIS OLD USER MESSAGE|CURRENT TOOL REQUEST/);
    assert.match(requestText(requests[2]), /unseen-tool-call/);
    assert.match(requestText(requests[2]), /notes_list_files/);
  });
});

test("automatic threshold rollover stores no summary transcript or consumed tail", async () => {
  await withHarness({ contextWindow: 80_000, reserveTokens: 1_000 }, async ({ manager, requests, responses, session }) => {
    responses.push(reply("OLD ANSWER", 79_000));
    await session.prompt("AUTO SECRET");

    const branch = manager.getBranch();
    const compaction = branch.findLast((entry) => entry.type === "compaction");
    assert.equal(compaction.details.owner, "pi-codex-context");
    assert.equal(compaction.details.kind, "rollover");
    assert.equal(compaction.firstKeptEntryId, compaction.details.boundaryId);
    assert.match(compaction.summary, /was not summarized/);

    responses.push(reply("NEW ANSWER"));
    await session.prompt("NEW REQUEST");
    assert.equal(requests.length, 2);
    assert.match(requestText(requests[1]), /NEW REQUEST/);
    assert.doesNotMatch(requestText(requests[1]), /AUTO SECRET|OLD ANSWER|was not summarized/);
  });
});

test("manual Pi compaction becomes a fresh no-summary window", async () => {
  await withHarness({ keepRecentTokens: 100 }, async ({ manager, requests, responses, session }) => {
    responses.push(reply("X".repeat(1_000)));
    await session.prompt("MANUAL SECRET");
    await session.compact();
    const compaction = manager.getBranch().findLast((entry) => entry.type === "compaction");
    assert.equal(compaction.details.kind, "rollover");
    assert.equal(compaction.details.previousWindowId != null, true);

    responses.push(reply("done"));
    await session.prompt("AFTER MANUAL");
    assert.doesNotMatch(requestText(requests[1]), /MANUAL SECRET|was not summarized/);
    assert.match(requestText(requests[1]), /AFTER MANUAL/);
  });
});

test("restores the current window boundary after reopening the session file", async () => {
  const first = await createHarness();
  let second;
  try {
    first.responses.push(toolCall("new_context", {}, "persisted-reset"), reply("done"));
    await first.session.prompt("RESUME OLD SECRET");
    const sessionFile = first.manager.getSessionFile();
    assert.ok(sessionFile);
    first.session.dispose();

    second = await createHarness({ manager: SessionManager.open(sessionFile) });
    second.responses.push(reply("resumed"));
    await second.session.prompt("AFTER RESUME");
    assert.doesNotMatch(requestText(second.requests[0]), /RESUME OLD SECRET|persisted-reset/);
    assert.match(requestText(second.requests[0]), /AFTER RESUME/);
    assert.deepEqual(second.extensionErrors, []);
    assert.deepEqual(second.providerRequests, []);
  } finally {
    await second?.close();
    await first.close();
  }
});

test("overflow rollover carries the unconsumed user input and drops the failed response", async () => {
  await withHarness({ contextWindow: 80_000, reserveTokens: 1_000 }, async ({ manager, requests, responses, session }) => {
    responses.push(overflow(), reply("RECOVERED"));
    await session.prompt("INPUT MUST SURVIVE");

    assert.equal(requests.length, 2);
    assert.match(requestText(requests[1]), /INPUT MUST SURVIVE/);
    assert.doesNotMatch(requestText(requests[1]), /PROVIDER-FAILED-RESPONSE/);
    const compaction = manager.getBranch().findLast((entry) => entry.type === "compaction");
    const carried = manager.getEntry(compaction.firstKeptEntryId);
    assert.equal(carried.type, "message");
    assert.equal(carried.message.role, "user");
  });
});

test("blocks new_context when it is mixed with another tool call", async () => {
  await withHarness({}, async ({ manager, requests, responses, session }) => {
    responses.push(
      toolCalls([
        { name: "new_context", id: "mixed-reset" },
        { name: "get_context_remaining", id: "remaining" },
      ]),
      reply("done"),
    );
    await session.prompt("keep this window");

    assert.equal(store.deriveWindowState(manager.getBranch()).windows.length, 1);
    assert.match(requestText(requests[1]), /new_context must be the only tool call/);
    assert.match(requestText(requests[1]), /tokens_left/);
  });
});

test("enforces task-local note paths", () => {
  assert.equal(store.normalizeNotePath("dir/state.md", "session"), "dir/state.md");
  assert.equal(store.normalizeNotePath("/session/notes/dir/state.md", "session"), "dir/state.md");
  assert.throws(() => store.normalizeNotePath("/other/notes/state.md", "session"), /another task/);
  assert.throws(() => store.normalizeNotePath("../state.md", "session"), /do not support/);
});
