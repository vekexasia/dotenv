import assert from "node:assert/strict";
import { copyFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHarness, overflow, reply, requestText, toolCall, toolCalls } from "./harness.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const store = await jiti.import(new URL("../extensions/store.ts", import.meta.url).pathname);
const windowDriver = await jiti.import(new URL("../extensions/window-driver.ts", import.meta.url).pathname);

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
    const failed = manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error");
    assert.ok(failed);
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

test("history_read advances Unicode pages by the emitted character count", async () => {
  await withHarness({}, async ({ manager, responses, session }) => {
    const source = "😀".repeat(20_000);
    responses.push(toolCall("history_list_items", { role: "user", limit: 1 }, "history-list"), reply("listed"));
    await session.prompt(source);
    const listed = manager.getBranch().findLast(
      (entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "history-list",
    );
    const item = listed.message.details.items.find((candidate) => candidate.role === "user");
    assert.ok(item);

    const pages = [];
    let offset = 0;
    for (let page = 0; page < 10; page++) {
      const callId = `history-read-${page}`;
      responses.push(toolCall("history_read", { item_id: item.item_id, offset_chars: offset }, callId), reply("read"));
      await session.prompt(`read page ${page}`);
      const result = manager.getBranch().findLast(
        (entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === callId,
      );
      const details = result.message.details;
      pages.push(details.content);
      if (details.next_offset_chars === null) {
        assert.equal(details.total_chars, Array.from(source).length);
        break;
      }
      assert.equal(details.next_offset_chars, offset + Array.from(details.content).length);
      assert.ok(details.next_offset_chars > offset);
      offset = details.next_offset_chars;
      assert.equal(page < 9, true);
    }
    assert.equal(pages.join(""), source);
  });
});

test("history_read keeps text and reports omitted oversized images", async () => {
  await withHarness({}, async ({ manager, responses, session }) => {
    responses.push(toolCall("history_list_items", { role: "user", limit: 1 }, "image-list"), reply("listed"));
    await session.prompt("image source", { images: [{ type: "image", data: "A".repeat(50_000), mimeType: "image/png" }] });
    const listed = manager.getBranch().findLast(
      (entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "image-list",
    );
    const item = listed.message.details.items.find((candidate) => candidate.role === "user");
    assert.ok(item);
    responses.push(toolCall("history_read", { item_id: item.item_id }, "image-read"), reply("read"));
    await session.prompt("read image");
    const read = manager.getBranch().findLast(
      (entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "image-read",
    );
    assert.match(read.message.details.content, /image source/);
    assert.equal(read.message.details.images_omitted, 1);
    assert.equal(read.message.content.filter((part) => part.type === "image").length, 0);
  });
});

test("accounts for prompt and active tool schema size before usage is available", () => {
  const model = { provider: "test", id: "accounting-model" };
  const context = (prompt) => ({ model, getSystemPrompt: () => prompt });
  const tools = (definitions) => ({
    getActiveTools: () => definitions.map((tool) => tool.name),
    getAllTools: () => definitions,
  });
  const narrow = [{ name: "schema-tool", description: "small", parameters: { type: "object" } }];
  const wide = [{ name: "schema-tool", description: "large", parameters: { type: "object", properties: {
    fields: { type: "array", items: { type: "string", description: "FIELD ".repeat(2_000) } },
  } } }];

  assert.equal(windowDriver.staticOverhead(tools([]), context("")), windowDriver.DEFAULT_STATIC_OVERHEAD);
  assert.ok(windowDriver.staticOverhead(tools(narrow), context("SYSTEM ".repeat(20_000))) >
    windowDriver.staticOverhead(tools(narrow), context("SYSTEM")));
  assert.ok(windowDriver.staticOverhead(tools(wide), context("SYSTEM")) >
    windowDriver.staticOverhead(tools(narrow), context("SYSTEM")));
});

test("reports remaining tokens using the effective prompt and tool schemas", async () => {
  const extraTool = (pi) => pi.registerTool({
    name: "accounting_extra",
    label: "Accounting extra",
    description: "EXTRA TOOL DESCRIPTION ".repeat(1_000),
    parameters: Type.Object({
      fields: Type.Array(Type.String({ description: "FIELD DESCRIPTION ".repeat(1_000) })),
    }),
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  const getRemaining = async (options) => {
    let remaining;
    await withHarness(options, async ({ manager, responses, session }) => {
      const remainingCall = toolCall("get_context_remaining", {}, "remaining");
      remainingCall.usage = undefined;
      responses.push(remainingCall, reply("done"));
      await session.prompt("ACCOUNTING INPUT");
      const result = manager.getBranch().findLast(
        (entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "remaining",
      );
      remaining = result.message.details.tokens_left;
    });
    return remaining;
  };

  const base = await getRemaining({ systemPrompt: "SYSTEM" });
  const expanded = await getRemaining({
    systemPrompt: "SYSTEM PROMPT ".repeat(10_000),
    beforeExtensions: [extraTool],
  });
  assert.ok(expanded < base);
});

test("pins the pre-seed reset-to-root leaf limitation and next append", async () => {
  let preseedId;
  await withHarness({
    setupManager(manager) {
      preseedId = manager.appendMessage({ role: "user", content: "PRESEEDED ROOT", timestamp: Date.now() });
    },
  }, async ({ lifecycleEvents, manager, responses, session }) => {
    responses.push(reply("later"));
    await session.prompt("later");
    const navigation = await session.navigateTree(preseedId, { summarize: false });
    const tree = lifecycleEvents.findLast((event) => event.kind === "tree");
    const seed = manager.getBranch().find((entry) => entry.type === "custom" && entry.customType === store.WINDOW_ENTRY);
    assert.equal(manager.getEntry(preseedId).parentId, null);
    assert.equal(navigation.editorText, "PRESEEDED ROOT");
    assert.ok(tree);
    assert.equal(tree.newLeafId, null);
    assert.equal(tree.leafAfterHooks, seed.id);
    assert.equal(manager.getLeafId(), seed.id);
    assert.notEqual(tree.newLeafId, preseedId);

    responses.push(reply("next"));
    await session.prompt("NEXT AFTER ROOT RESET");
    const nextUser = manager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user");
    assert.equal(nextUser.parentId, seed.id);
  });
});

test("preserves native tree summarization and appends one branch summary", async () => {
  await withHarness({}, async ({ lifecycleEvents, manager, requests, responses, session }) => {
    responses.push(reply("first reply"), reply("second reply"));
    await session.prompt("first branch");
    await session.prompt("second branch");
    const target = manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user");
    responses.push(reply("NATIVE SUMMARY"));
    const result = await session.navigateTree(target.id, { summarize: true });
    const summaries = manager.getEntries().filter((entry) => entry.type === "branch_summary");
    const tree = lifecycleEvents.findLast((event) => event.kind === "tree");
    assert.equal(requests.length, 3);
    const summaryRequests = requests.filter((request) => requestText(request).includes("<conversation>"));
    assert.equal(summaryRequests.length, 1);
    assert.match(requestText(summaryRequests[0]), /Create a structured summary/);
    assert.equal(summaries.length, 1);
    assert.match(summaries[0].summary, /NATIVE SUMMARY/);
    assert.equal(result.summaryEntry.id, summaries[0].id);
    assert.ok(tree);
  });
});

test("tree navigation reanchors carried user, tool-call, and tool-result entries", async () => {
  for (const targetKind of ["user", "assistant", "toolResult"]) {
    const harness = await createHarness({ contextWindow: 80_000, reserveTokens: 1_000, keepRecentTokens: targetKind === "user" ? 1 : 100 });
    try {
      if (targetKind === "user") {
        harness.responses.push(overflow(), reply("recovered"));
        await harness.session.prompt("CARRIED USER");
      } else {
        harness.responses.push(reply("X".repeat(1_000)));
        await harness.session.prompt("OLD TRANSCRIPT");
        const call = toolCall("notes_list_files", {}, "carried-call");
        call.usage = { ...call.usage, input: 79_000, output: 10, totalTokens: 79_010 };
        harness.responses.push(call, reply("carried result"));
        await harness.session.prompt("CURRENT REQUEST");
      }

      const entries = harness.manager.getEntries();
      const target = targetKind === "user"
        ? entries.find((entry) => entry.type === "message" && entry.message.role === "user")
        : targetKind === "assistant"
          ? entries.find((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((part) => part.type === "toolCall"))
          : entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
      const compaction = entries.findLast((entry) => entry.type === "compaction");
      assert.ok(target);
      assert.ok(compaction);
      const expectedWindowId = compaction.details.windowId;

      const navigation = await harness.session.navigateTree(target.id, { summarize: false });
      assert.equal(navigation.cancelled, false);
      assert.equal(store.deriveWindowState(harness.manager.getBranch()).currentWindowId, expectedWindowId);
      assert.equal(store.deriveWindowState(harness.manager.getBranch()).windows.length, 2);
      const reanchors = harness.manager.getBranch().filter(
        (entry) => entry.type === "custom" && entry.customType === store.WINDOW_ENTRY && entry.data.kind === "reanchor",
      );
      assert.equal(reanchors.length, 1);
      if (targetKind === "user") assert.equal(navigation.editorText, "CARRIED USER");

      const projected = windowDriver.projectedMessages(harness.manager, store.deriveWindowState(harness.manager.getBranch()));
      if (targetKind === "assistant") assert.ok(projected.some((message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.id === "carried-call")));
      if (targetKind === "toolResult") assert.ok(projected.some((message) => message.role === "toolResult" && message.toolCallId === "carried-call"));
      assert.deepEqual(harness.extensionErrors, []);
      assert.deepEqual(harness.providerRequests, []);
    } finally {
      await harness.close();
    }
  }
});

test("keeps a reanchored batch valid when a later rollover carries it", async () => {
  const cases = [
    { label: "overflow user", targetKind: "user" },
    { label: "threshold tool call", targetKind: "assistant" },
    { label: "threshold tool result", targetKind: "toolResult" },
  ];
  for (const { label, targetKind } of cases) {
    let first;
    let second;
    try {
      first = await createHarness({ contextWindow: 80_000, reserveTokens: 1_000, keepRecentTokens: targetKind === "user" ? 1 : 100 });
      if (targetKind === "user") {
        first.responses.push(overflow(), reply("initial recovery"));
        await first.session.prompt("CARRIED USER");
      } else {
        first.responses.push(reply("X".repeat(1_000)));
        await first.session.prompt("OLD TRANSCRIPT");
        const call = toolCall("notes_list_files", {}, `${targetKind}-same-batch-call`);
        call.usage = { ...call.usage, input: 79_000, output: 10, totalTokens: 79_010 };
        first.responses.push(call, reply("carried result"));
        await first.session.prompt("CURRENT REQUEST");
      }

      const target = first.manager.getEntries().find((entry) => entry.type === "message" && (
        targetKind === "user"
          ? entry.message.role === "user" && entry.message.content.some((part) => part.type === "text" && part.text === "CARRIED USER")
          : targetKind === "assistant"
            ? entry.message.role === "assistant" && entry.message.content.some((part) => part.type === "toolCall")
            : entry.message.role === "toolResult"
      ));
      assert.ok(target, label);
      const beforeNavigationState = store.deriveWindowState(first.manager.getBranch());
      const beforeNavigationItems = store.historyItems(first.manager.getBranch(), beforeNavigationState);
      const beforeNavigationTarget = beforeNavigationItems.find((item) => item.item_id.startsWith(`${target.id}:`));
      assert.ok(beforeNavigationTarget, label);
      await first.session.navigateTree(target.id, { summarize: false });

      first.responses.push(overflow(), reply("second recovery"));
      await first.session.prompt(`REPEAT ${label}`);
      assert.doesNotMatch(requestText(first.requests.at(-1)), /context_window_error/);
      assert.equal(store.deriveWindowState(first.manager.getBranch()).windows.length, 3, label);
      const firstReanchor = first.manager.getEntries().find(
        (entry) => entry.type === "custom" && entry.customType === store.WINDOW_ENTRY && entry.data.kind === "reanchor" && entry.data.targetId === target.id,
      );
      assert.ok(firstReanchor);
      const indexedHistory = store.historyItems(first.manager.getBranch(), store.deriveWindowState(first.manager.getBranch()));
      const carriedItem = indexedHistory.find((item) => item.item_id.startsWith(`${target.id}:`));
      const laterOnlyItem = indexedHistory.find((item) => item.content === `REPEAT ${label}`);
      assert.ok(laterOnlyItem, JSON.stringify(indexedHistory.map((item) => ({ content: item.content, window: item.window_id }))));
      assert.equal(laterOnlyItem.window_id, indexedHistory.at(-1).window_id, label);
      if (targetKind === "user") {
        assert.equal(beforeNavigationTarget.window_id, firstReanchor.data.windowId, label);
      } else {
        assert.ok(carriedItem, JSON.stringify(indexedHistory.map((item) => ({ content: item.content, id: item.item_id, window: item.window_id }))));
        assert.equal(carriedItem.window_id, firstReanchor.data.windowId, label);
      }

      const sessionFile = first.manager.getSessionFile();
      assert.ok(sessionFile);
      first.session.dispose();
      second = await createHarness({ manager: SessionManager.open(sessionFile), reserveTokens: 1, keepRecentTokens: 100 });
      second.responses.push(reply("after reopen"));
      await second.session.prompt("AFTER REOPEN");
      assert.doesNotMatch(requestText(second.requests[0]), /context_window_error/);
      assert.equal(store.deriveWindowState(second.manager.getBranch()).windows.length, 3);
      await second.session.navigateTree(target.id, { summarize: false });
      second.responses.push(reply("after repeat navigation"));
      await second.session.prompt("AFTER REPEAT NAVIGATION");
      const repeatState = store.deriveWindowState(second.manager.getBranch());
      assert.doesNotMatch(requestText(second.requests.at(-1)), /context_window_error/);
      assert.equal(repeatState.currentWindowId, firstReanchor.data.windowId, label);
      assert.equal(repeatState.windows.length, 2);
      assert.deepEqual(second.extensionErrors, []);
      assert.deepEqual(second.providerRequests, []);
    } finally {
      await second?.close();
      await first?.close();
    }
  }
});

test("keeps notes and history on the active tree lineage", async () => {
  await withHarness({}, async ({ manager, responses, session }) => {
    responses.push(
      toolCall("notes_write_file", { path: "branch.md", text: "BRANCH ONE NOTE" }, "branch-note"),
      reply("branch one reply"),
    );
    await session.prompt("BRANCH ONE HISTORY");
    const branchOneUser = manager.getEntries().find(
      (entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("BRANCH ONE HISTORY"),
    );
    const branchOneLeaf = manager.getLeafId();
    assert.ok(branchOneUser);
    assert.ok(branchOneLeaf);

    await session.navigateTree(branchOneUser.id, { summarize: false });
    responses.push(
      toolCall("notes_list_files", {}, "branch-two-notes"),
      toolCall("history_search_contents", { query: "BRANCH ONE HISTORY" }, "branch-two-history"),
      reply("branch two reply"),
    );
    await session.prompt("BRANCH TWO HISTORY");
    const branchTwoNotes = manager.getBranch().findLast(
      (entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "branch-two-notes",
    );
    const branchTwoHistory = manager.getBranch().findLast(
      (entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "branch-two-history",
    );
    assert.deepEqual(branchTwoNotes.message.details.files, []);
    assert.deepEqual(branchTwoHistory.message.details.items.filter((item) => item.role === "user"), []);

    await session.navigateTree(branchOneLeaf, { summarize: false });
    responses.push(
      toolCall("notes_list_files", {}, "branch-one-notes"),
      toolCall("history_search_contents", { query: "BRANCH ONE HISTORY" }, "branch-one-history"),
      reply("branch one resumed"),
    );
    await session.prompt("CHECK ACTIVE BRANCH");
    const branchOneNotes = manager.getBranch().findLast(
      (entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "branch-one-notes",
    );
    const branchOneHistory = manager.getBranch().findLast(
      (entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "branch-one-history",
    );
    assert.deepEqual(branchOneNotes.message.details.files.map((file) => file.path), ["branch.md"]);
    assert.equal(branchOneHistory.message.details.items.filter((item) => item.role === "user").length, 1);
  });
});

test("recovers an explicit reset when tree navigation reaches its result", async () => {
  let resetResultId;
  let branchUserId;
  await withHarness({
    setupManager(manager) {
      const seed = "tree-reset-recovery-window";
      manager.appendCustomEntry(store.WINDOW_ENTRY, { version: 1, kind: "seed", firstWindowId: seed, windowId: seed });
      branchUserId = manager.appendMessage({ role: "user", content: "OLD TRANSCRIPT", timestamp: Date.now() });
      const assistantId = manager.appendMessage(toolCall("new_context", {}, "tree-recovery-reset"));
      manager.appendCustomEntry(store.RESET_ENTRY, {
        version: 1,
        kind: "prepare",
        toolCallId: "tree-recovery-reset",
        assistantEntryId: assistantId,
      });
      resetResultId = manager.appendMessage({
        role: "toolResult",
        toolCallId: "tree-recovery-reset",
        toolName: "new_context",
        content: [{ type: "text", text: "reset" }],
        isError: false,
        timestamp: new Date().toISOString(),
      });
      manager.branch(branchUserId);
      manager.appendMessage({ role: "user", content: "ACTIVE OTHER BRANCH", timestamp: Date.now() });
    },
  }, async ({ manager, requests, responses, session }) => {
    await session.navigateTree(resetResultId, { summarize: false });
    responses.push(reply("recovered on tree"));
    await session.prompt("AFTER TREE RESET RECOVERY");
    const state = store.deriveWindowState(manager.getBranch());
    assert.equal(manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === store.WINDOW_ENTRY && entry.data.kind === "commit").length, 1);
    assert.equal(state.windows.length, 2);
    assert.doesNotMatch(requestText(requests[0]), /OLD TRANSCRIPT/);
    assert.match(requestText(requests[0]), /AFTER TREE RESET RECOVERY/);
  });
});

test("validates malformed owned state during tree navigation", async () => {
  let targetId;
  await withHarness({
    setupManager(manager) {
      const windowId = "tree-validation-window";
      manager.appendCustomEntry(store.WINDOW_ENTRY, { version: 1, kind: "seed", firstWindowId: windowId, windowId });
      targetId = manager.appendMessage({ role: "user", content: "MALFORMED TREE OLD", timestamp: Date.now() });
    },
  }, async ({ manager, requests, responses, session }) => {
    manager.appendCustomEntry(store.WINDOW_ENTRY, {
      version: 1,
      kind: "reanchor",
      firstWindowId: "tree-validation-window",
      windowId: "tree-validation-window",
      reason: "tree",
      targetId,
      targetParentId: "missing-tree-parent",
    });
    await session.navigateTree(targetId, { summarize: false });
    responses.push(reply("not reached"));
    await session.prompt("TREE VALIDATION REQUEST");
    assert.equal(requests.length, 1);
    assert.match(requestText(requests[0]), /context_window_error/);
    assert.doesNotMatch(requestText(requests[0]), /MALFORMED TREE OLD/);
  });
});

test("navigates directly across explicit window markers without adding windows", async () => {
  await withHarness({}, async ({ manager, responses, session }) => {
    responses.push(
      toolCall("new_context", {}, "tree-reset-1"),
      toolCall("new_context", {}, "tree-reset-2"),
      reply("done"),
    );
    await session.prompt("TREE WINDOW ONE");
    const commits = manager.getEntries().filter(
      (entry) => entry.type === "custom" && entry.customType === store.WINDOW_ENTRY && entry.data.kind === "commit",
    );
    assert.equal(commits.length, 2);

    await session.navigateTree(commits[0].id, { summarize: false });
    let state = store.deriveWindowState(manager.getBranch());
    assert.equal(manager.getLeafId(), commits[0].id);
    assert.equal(state.currentWindowId, state.windows[1]);

    await session.navigateTree(commits[1].id, { summarize: false });
    state = store.deriveWindowState(manager.getBranch());
    assert.equal(manager.getLeafId(), commits[1].id);
    assert.equal(state.currentWindowId, state.windows[2]);
    assert.equal(state.windows.length, 3);
  });
});

test("preserves synthetic messages across a boundary with surrounding hooks", async () => {
  const beforeHook = (pi) => pi.on("before_agent_start", () => ({
    message: { customType: "before-hook", content: "BEFORE HOOK", display: false },
  }));
  const afterHook = (pi) => pi.on("before_agent_start", () => ({
    message: { customType: "after-hook", content: "AFTER HOOK", display: false },
  }));
  await withHarness({ beforeExtensions: [beforeHook], afterExtensions: [afterHook] }, async ({ requests, responses, session }) => {
    responses.push(toolCall("new_context", {}, "hook-reset"), reply("done"));
    await session.prompt("ORDINARY BEFORE BOUNDARY");
    assert.equal(requests.length, 2);
    assert.doesNotMatch(requestText(requests[1]), /ORDINARY BEFORE BOUNDARY/);
    assert.match(requestText(requests[1]), /BEFORE HOOK/);
    assert.match(requestText(requests[1]), /AFTER HOOK/);
  });
});

test("reopens and completes a persisted explicit reset prepare exactly once", async () => {
  let first;
  let second;
  try {
    first = await createHarness({
      setupManager(manager) {
        const seed = "recovery-window";
        manager.appendCustomEntry(store.WINDOW_ENTRY, { version: 1, kind: "seed", firstWindowId: seed, windowId: seed });
        manager.appendMessage({ role: "user", content: "before reset", timestamp: Date.now() });
        manager.appendMessage(toolCall("new_context", {}, "recover-reset"));
        manager.appendCustomEntry(store.RESET_ENTRY, {
          version: 1,
          kind: "prepare",
          toolCallId: "recover-reset",
          assistantEntryId: manager.getLeafId(),
        });
        manager.appendMessage({
          role: "toolResult",
          toolCallId: "recover-reset",
          toolName: "new_context",
          content: [{ type: "text", text: "reset" }],
          isError: false,
          timestamp: Date.now(),
        });
      },
    });
    const sessionFile = first.manager.getSessionFile();
    assert.ok(sessionFile);
    assert.equal(first.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === store.WINDOW_ENTRY && entry.data.kind === "commit").length, 1);
    first.session.dispose();

    second = await createHarness({ manager: SessionManager.open(sessionFile) });
    assert.equal(second.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === store.WINDOW_ENTRY && entry.data.kind === "commit").length, 1);
    assert.deepEqual(second.extensionErrors, []);
    assert.deepEqual(second.providerRequests, []);
  } finally {
    second?.session.dispose();
    await second?.close();
    await first?.close();
  }
});

test("fails closed when a foreign compaction follows a managed seed", async () => {
  const harness = await createHarness({
    setupManager(manager) {
      const seed = "foreign-compaction-window";
      const seedId = manager.appendCustomEntry(store.WINDOW_ENTRY, { version: 1, kind: "seed", firstWindowId: seed, windowId: seed });
      manager.appendMessage({ role: "user", content: "OLD TRANSCRIPT MUST NOT LEAK", timestamp: Date.now() });
      manager.appendCompaction("foreign summary", seedId, 1, { owner: "foreign-provider" });
    },
  });
  try {
    await harness.session.prompt("new request");
    assert.equal(harness.providerRequests.length, 0);
    assert.equal(harness.requests.length, 1);
    assert.match(requestText(harness.requests[0]), /context_window_error/);
    assert.doesNotMatch(requestText(harness.requests[0]), /OLD TRANSCRIPT MUST NOT LEAK/);
    assert.deepEqual(harness.extensionErrors, []);
  } finally {
    await harness.close();
  }
});

test("poisons the session when compaction failure reveals malformed owned state", async () => {
  let injectOnce = true;
  const injectMalformedState = (pi) => pi.on("session_before_compact", (_event, ctx) => {
    if (!injectOnce) return;
    injectOnce = false;
    ctx.sessionManager.appendCustomEntry(store.WINDOW_ENTRY, { version: 1, kind: "invalid" });
    return { cancel: true };
  });
  await withHarness({
    contextWindow: 80_000,
    reserveTokens: 1_000,
    afterExtensions: [injectMalformedState],
  }, async ({ requests, responses, session, lifecycleEvents }) => {
    responses.push(reply("MALFORMED COMPACTION", 79_000));
    await session.prompt("TRIGGER COMPACTION FAILURE");
    assert.equal(lifecycleEvents.at(-1).kind, "compact_failed");
    responses.push(reply("not reached"));
    await session.prompt("MUST FAIL CLOSED");
    assert.match(requestText(requests.at(-1)), /context_window_error/);
  });
});

test("treats an aborted anchor without a compaction as inert", () => {
  const manager = SessionManager.inMemory();
  const seed = "dangling-anchor-window";
  manager.appendCustomEntry(store.WINDOW_ENTRY, { version: 1, kind: "seed", firstWindowId: seed, windowId: seed });
  manager.appendMessage({ role: "user", content: "partial rollover", timestamp: Date.now() });
  manager.appendCustomEntry(store.WINDOW_ENTRY, {
    version: 1,
    kind: "anchor",
    firstWindowId: seed,
    previousWindowId: seed,
    windowId: "new-window",
    reason: "threshold",
    txId: "transaction",
  });
  assert.equal(windowDriver.validateOwnedCompactions(manager.getEntries()), undefined);
  assert.equal(store.deriveWindowState(manager.getBranch()).currentWindowId, seed);
});

test("recovers an explicit reset aborted after its successful tool result", async () => {
  let reachedResolve;
  let releaseResolve;
  const reached = new Promise((resolve) => { reachedResolve = resolve; });
  const released = new Promise((resolve) => { releaseResolve = resolve; });
  const holdAfterResult = (pi) => pi.on("tool_result", async (event) => {
    if (event.toolCallId === "aborted-reset") {
      reachedResolve();
      await released;
    }
  });
  let first;
  let second;
  try {
    first = await createHarness({ afterExtensions: [holdAfterResult] });
    first.responses.push(toolCall("new_context", {}, "aborted-reset"));
    const prompt = first.session.prompt("ABORT AFTER TOOL RESULT");
    await reached;
    const abort = first.session.abort();
    releaseResolve();
    await Promise.allSettled([prompt, abort]);

    const sessionFile = first.manager.getSessionFile();
    assert.ok(sessionFile);
    first.session.dispose();
    second = await createHarness({ manager: SessionManager.open(sessionFile) });
    assert.equal(second.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === store.WINDOW_ENTRY && entry.data.kind === "commit").length, 1);
    second.session.dispose();
    const third = await createHarness({ manager: SessionManager.open(sessionFile) });
    try {
      assert.equal(third.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === store.WINDOW_ENTRY && entry.data.kind === "commit").length, 1);
    } finally {
      await third.close();
    }
  } finally {
    await second?.close();
    await first?.close();
  }
});

test("does not execute a tool aborted before tool execution", async () => {
  let executed = false;
  const abortBeforeTool = (pi) => {
    pi.registerTool({
      name: "abortable_test_tool",
      label: "Abortable test tool",
      description: "A test-only abortable tool.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_id, _args, signal) {
        executed = true;
        signal.throwIfAborted();
        return { content: [{ type: "text", text: "executed" }] };
      },
    });
    pi.on("tool_call", (event, ctx) => {
      if (event.toolCallId === "before-tool-abort") ctx.abort();
    });
  };

  await withHarness({ beforeExtensions: [abortBeforeTool] }, async ({ manager, requests, responses, session }) => {
    responses.push(toolCall("abortable_test_tool", {}, "before-tool-abort"));
    await session.prompt("ABORT BEFORE TOOL");
    const result = manager.getBranch().findLast(
      (entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "before-tool-abort",
    );
    assert.equal(executed, false);
    assert.equal(result.message.isError, true);
    assert.equal(store.deriveWindowState(manager.getBranch()).windows.length, 1);
    assert.equal(requests.length, 1);
  });
});

test("reopens an explicit reset snapshot safely after aborting before its result persists", async () => {
  let reachedResolve;
  let releaseResolve;
  const reached = new Promise((resolve) => { reachedResolve = resolve; });
  const released = new Promise((resolve) => { releaseResolve = resolve; });
  let prepareSeen = false;
  const holdBeforeResultPersistence = (pi) => pi.on("tool_result", async (event, ctx) => {
    if (event.toolCallId !== "snapshot-reset") return;
    prepareSeen = ctx.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === store.RESET_ENTRY);
    reachedResolve();
    await released;
  });
  let first;
  let second;
  try {
    first = await createHarness({ afterExtensions: [holdBeforeResultPersistence] });
    first.responses.push(toolCall("new_context", {}, "snapshot-reset"));
    const prompt = first.session.prompt("ABORT BEFORE RESET RESULT");
    await reached;
    assert.equal(prepareSeen, true);

    const sessionFile = first.manager.getSessionFile();
    assert.ok(sessionFile);
    const partialSessionFile = `${sessionFile}.partial`;
    const abort = first.session.abort();
    await copyFile(sessionFile, partialSessionFile);
    releaseResolve();
    await Promise.allSettled([prompt, abort]);
    first.session.dispose();

    second = await createHarness({ manager: SessionManager.open(partialSessionFile) });
    assert.equal(second.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === store.RESET_ENTRY).length, 1);
    assert.equal(second.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === store.WINDOW_ENTRY && entry.data.kind === "commit").length, 0);
    second.responses.push(reply("after partial reset"));
    await second.session.prompt("AFTER PARTIAL RESET");
    assert.equal(second.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === store.WINDOW_ENTRY && entry.data.kind === "commit").length, 0);
    assert.doesNotMatch(requestText(second.requests[0]), /context_window_error/);
    assert.deepEqual(second.extensionErrors, []);
    assert.deepEqual(second.providerRequests, []);
  } finally {
    await second?.close();
    await first?.close();
  }
});

test("reopens safely after automatic compaction aborts through its signal", async () => {
  let abortOnce = true;
  const abortAutomaticCompaction = (pi) => pi.on("session_before_compact", (event, ctx) => {
    if (event.reason === "threshold" && abortOnce) {
      abortOnce = false;
      ctx.abort();
    }
  });
  let first;
  let second;
  try {
    first = await createHarness({
      contextWindow: 80_000,
      reserveTokens: 1_000,
      afterExtensions: [abortAutomaticCompaction],
    });
    first.responses.push(reply("ABORTED SIGNAL COMPACTION", 79_000));
    await first.session.prompt("BEFORE SIGNAL ABORT");
    assert.equal(first.lifecycleEvents.at(-1).kind, "compact_failed");
    assert.equal(first.lifecycleEvents.at(-1).aborted, true);
    assert.equal(first.manager.getEntries().filter((entry) => entry.type === "compaction").length, 0);

    const sessionFile = first.manager.getSessionFile();
    assert.ok(sessionFile);
    first.session.dispose();
    second = await createHarness({ manager: SessionManager.open(sessionFile) });
    second.responses.push(reply("AFTER SIGNAL REOPEN"));
    await second.session.prompt("AFTER SIGNAL REOPEN");
    assert.equal(second.manager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
    assert.equal(store.deriveWindowState(second.manager.getBranch()).windows.length, 2);
    assert.doesNotMatch(requestText(second.requests[0]), /context_window_error/);
    assert.deepEqual(second.extensionErrors, []);
    assert.deepEqual(second.providerRequests, []);
  } finally {
    await second?.close();
    await first?.close();
  }
});

test("reopens safely after compaction is cancelled after the anchor append", async () => {
  let cancelOnce = true;
  const cancelAfterAnchor = (pi) => pi.on("session_before_compact", () => {
    if (cancelOnce) {
      cancelOnce = false;
      return { cancel: true };
    }
  });
  let first;
  let second;
  try {
    first = await createHarness({
      contextWindow: 80_000,
      reserveTokens: 1_000,
      afterExtensions: [cancelAfterAnchor],
    });
    first.responses.push(reply("ABORTED COMPACTION", 79_000));
    await first.session.prompt("BEFORE ABORTED COMPACTION");
    assert.equal(first.lifecycleEvents.at(-1).kind, "compact_failed");
    assert.equal(first.manager.getEntries().filter((entry) => entry.type === "compaction").length, 0);

    const sessionFile = first.manager.getSessionFile();
    assert.ok(sessionFile);
    first.session.dispose();
    second = await createHarness({ manager: SessionManager.open(sessionFile) });
    second.responses.push(reply("AFTER REOPEN"));
    await second.session.prompt("AFTER REOPEN");
    assert.equal(second.manager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
    assert.equal(store.deriveWindowState(second.manager.getBranch()).windows.length, 2);
    assert.match(requestText(second.requests[0]), /AFTER REOPEN/);
    assert.doesNotMatch(requestText(second.requests[0]), /context_window_error/);
    assert.deepEqual(second.extensionErrors, []);
  } finally {
    await second?.close();
    await first?.close();
  }
});

test("ignores a foreign reanchor when resolving an entry origin", () => {
  const manager = SessionManager.inMemory();
  const seed = "origin-seed";
  const seedId = manager.appendCustomEntry(store.WINDOW_ENTRY, { version: 1, kind: "seed", firstWindowId: seed, windowId: seed });
  const sourceId = manager.appendMessage({ role: "user", content: "source", timestamp: Date.now() });
  manager.appendCustomEntry(store.WINDOW_ENTRY, {
    version: 1,
    kind: "reanchor",
    firstWindowId: "foreign-first-window",
    windowId: "foreign-window",
    previousWindowId: seed,
    reason: "tree",
    targetId: sourceId,
    targetParentId: seedId,
  });
  const targetId = manager.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
  assert.equal(store.windowOriginForEntry(manager.getEntries(), targetId).windowId, seed);
});

test("rejects duplicate entry ids from the replay index", () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry(store.WINDOW_ENTRY, { version: 1, kind: "seed", firstWindowId: "duplicate-window", windowId: "duplicate-window" });
  const entries = manager.getEntries();
  entries.push({ ...entries[0], id: entries[0].id });
  assert.match(windowDriver.validateOwnedCompactions(entries), /duplicate entry id/);
});

test("rejects a malformed reanchor parent before projecting context", () => {
  const manager = SessionManager.inMemory();
  const seed = "validation-window";
  manager.appendCustomEntry(store.WINDOW_ENTRY, { version: 1, kind: "seed", firstWindowId: seed, windowId: seed });
  const userId = manager.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
  manager.appendCustomEntry(store.WINDOW_ENTRY, {
    version: 1,
    kind: "reanchor",
    firstWindowId: seed,
    windowId: seed,
    reason: "tree",
    targetId: userId,
    targetParentId: "missing-parent",
  });
  assert.match(windowDriver.validateOwnedCompactions(manager.getEntries()), /target parent/);
});

test("rejects multiple seeds on one tree path", () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry(store.WINDOW_ENTRY, { version: 1, kind: "seed", firstWindowId: "first-seed", windowId: "first-seed" });
  manager.appendCustomEntry(store.WINDOW_ENTRY, { version: 1, kind: "seed", firstWindowId: "second-seed", windowId: "second-seed" });
  assert.match(windowDriver.validateOwnedCompactions(manager.getEntries()), /exactly one seed/);
});

test("enforces task-local note paths", () => {
  assert.equal(store.normalizeNotePath("dir/state.md", "session"), "dir/state.md");
  assert.equal(store.normalizeNotePath("/session/notes/dir/state.md", "session"), "dir/state.md");
  assert.throws(() => store.normalizeNotePath("/other/notes/state.md", "session"), /another task/);
  assert.throws(() => store.normalizeNotePath("../state.md", "session"), /do not support/);
});
