import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  deriveWindowState,
  historyItems,
  isCurrentAgent,
  normalizeNotePath,
  readNotes,
  saveNote,
  type HistoryItem,
  type WindowState,
} from "./store.js";

const MAX_OUTPUT_BYTES = 48_000;
const ROLES = ["user", "assistant", "tool", "developer"] as const;
const ORDERS = ["oldest_first", "recent_first"] as const;

type Role = typeof ROLES[number];
type Order = typeof ORDERS[number];

interface Runtime {
  getRemaining(ctx: ExtensionContext): { tokens_left: number; context_window: number };
  requestReset(toolCallId: string, ctx: ExtensionContext): void;
}

function chars(text: string): string[] {
  return Array.from(text);
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  const value = chars(text);
  let low = 0;
  let high = Math.min(value.length, limit);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(value.slice(0, middle).join(""))) <= 40_000) low = middle;
    else high = middle - 1;
  }
  return { text: value.slice(0, low).join(""), truncated: low < value.length };
}

function result(data: unknown, images: HistoryItem["images"] = []): AgentToolResult<unknown> {
  let value = data;
  let text = JSON.stringify(value);
  const textBytes = Buffer.byteLength(text);
  const imageBytes = images.reduce((total, image) => total + Buffer.byteLength(JSON.stringify(image)), 0);
  if (images.length > 0 && textBytes <= MAX_OUTPUT_BYTES && textBytes + imageBytes > MAX_OUTPUT_BYTES &&
    value !== null && typeof value === "object" && !Array.isArray(value)) {
    value = { ...value, images_omitted: images.length };
    text = JSON.stringify(value);
    images = [];
  } else if (textBytes + imageBytes > MAX_OUTPUT_BYTES) {
    value = { error: "Result exceeded the tool output limit; narrow the query or page the results" };
    text = JSON.stringify(value);
    images = [];
  }
  return {
    content: [{ type: "text", text }, ...images],
    details: value,
  };
}

function listResult(key: string, base: Record<string, unknown>, values: unknown[]): AgentToolResult<unknown> {
  const kept = [...values];
  const payload = (truncated: boolean): Record<string, unknown> => {
    const adjusted = { ...base };
    if (typeof base.offset === "number" && typeof base.total === "number") {
      const next = base.offset + kept.length;
      adjusted.next_offset = next < base.total ? next : null;
    }
    return { ...adjusted, [key]: kept, truncated };
  };
  let value = payload(false);
  while (kept.length && Buffer.byteLength(JSON.stringify(value)) > MAX_OUTPUT_BYTES) {
    kept.pop();
    value = payload(true);
  }
  return result(value);
}

function state(ctx: ExtensionContext): WindowState {
  const value = deriveWindowState(ctx.sessionManager.getBranch());
  if (!value) throw new Error("Context window state is unavailable");
  return value;
}

function publicItem(item: HistoryItem, maxChars: number): Record<string, unknown> {
  const content = truncate(item.content, maxChars);
  return {
    window_id: item.window_id,
    item_id: item.item_id,
    ordinal: item.ordinal,
    created_at: item.created_at,
    role: item.role,
    tool_namespace: item.tool_namespace,
    tool_name: item.tool_name,
    content: content.text,
    content_truncated: content.truncated,
    image_count: item.images.length,
  };
}

function selectedItems(ctx: ExtensionContext, agentName?: string | null): HistoryItem[] {
  if (!isCurrentAgent(agentName, ctx.sessionManager)) return [];
  const window = state(ctx);
  return historyItems(ctx.sessionManager.getBranch(), window);
}

export function registerTools(pi: ExtensionAPI, runtime: Runtime): void {
  pi.registerTool({
    name: "get_context_remaining",
    label: "Context remaining",
    description: "Get the number of weighted tokens left in the current context window.",
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "parallel",
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      return result(runtime.getRemaining(ctx));
    },
  });

  pi.registerTool({
    name: "new_context",
    label: "New context",
    description: "Start a fresh context window. This tool must be the only tool call in the assistant response. Save durable state with notes_write_file or notes_append_file before calling it when useful. Earlier messages remain available through history tools.",
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(id, _params, _signal, _onUpdate, ctx) {
      runtime.requestReset(id, ctx);
      return result({ reset_context: true });
    },
  });

  pi.registerTool({
    name: "notes_write_file",
    label: "Write context note",
    description: "Write a task-local virtual note, replacing the file if it exists. Relative paths are rooted under the current task's notes directory.",
    parameters: Type.Object({ path: Type.String(), text: Type.String() }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const file = saveNote(pi, ctx.sessionManager, "write", params.path, params.text);
      return result({ path: file.path, bytes: file.bytes, created_at: file.created_at, updated_at: file.updated_at });
    },
  });

  pi.registerTool({
    name: "notes_append_file",
    label: "Append context note",
    description: "Append text to a task-local virtual note, creating the file if needed.",
    parameters: Type.Object({ path: Type.String(), text: Type.String() }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const file = saveNote(pi, ctx.sessionManager, "append", params.path, params.text);
      return result({ path: file.path, bytes: file.bytes, created_at: file.created_at, updated_at: file.updated_at });
    },
  });

  pi.registerTool({
    name: "notes_read_file",
    label: "Read context note",
    description: "Read a task-local virtual note, optionally selecting an inclusive line range. Negative line numbers count from the end.",
    parameters: Type.Object({
      path: Type.String(),
      line_start: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
      line_stop: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    }),
    executionMode: "parallel",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = normalizeNotePath(params.path, ctx.sessionManager.getSessionId());
      const file = readNotes(ctx.sessionManager.getBranch()).find((candidate) => candidate.path === path);
      if (!file) throw new Error(`Note not found: ${path}`);
      const lines = file.text.split("\n");
      const resolveLine = (line: number | null | undefined, fallback: number) => line == null ? fallback : line < 0 ? lines.length + line + 1 : line;
      const start = Math.max(1, resolveLine(params.line_start, 1));
      const stop = Math.min(lines.length, resolveLine(params.line_stop, lines.length));
      const selected = stop < start ? "" : lines.slice(start - 1, stop).join("\n");
      const content = truncate(selected, 40_000);
      return result({ path, line_start: start, line_stop: stop, content: content.text, content_truncated: content.truncated });
    },
  });

  pi.registerTool({
    name: "notes_list_files",
    label: "List context notes",
    description: "List task-local virtual note files under an optional path prefix.",
    parameters: Type.Object({ prefix: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
    executionMode: "parallel",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const prefix = params.prefix == null ? "" : normalizeNotePath(params.prefix, ctx.sessionManager.getSessionId(), true);
      const files = readNotes(ctx.sessionManager.getBranch())
        .filter((file) => file.path.startsWith(prefix))
        .sort((a, b) => a.path.localeCompare(b.path))
        .map(({ path, bytes, created_at, updated_at }) => ({ path, bytes, created_at, updated_at }));
      return listResult("files", { prefix }, files);
    },
  });

  pi.registerTool({
    name: "notes_search_contents",
    label: "Search context notes",
    description: "Search task-local virtual notes for a literal query and return matching lines.",
    parameters: Type.Object({
      query: Type.String(),
      prefix: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      max_results: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 100 }), Type.Null()])),
    }),
    executionMode: "parallel",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const prefix = params.prefix == null ? "" : normalizeNotePath(params.prefix, ctx.sessionManager.getSessionId(), true);
      const maximum = params.max_results ?? 20;
      const matches: Array<{ path: string; line: number; content: string; content_truncated: boolean }> = [];
      for (const file of readNotes(ctx.sessionManager.getBranch()).filter((candidate) => candidate.path.startsWith(prefix))) {
        for (const [index, line] of file.text.split("\n").entries()) {
          if (!line.includes(params.query)) continue;
          const content = truncate(line, 2_000);
          matches.push({ path: file.path, line: index + 1, content: content.text, content_truncated: content.truncated });
          if (matches.length >= maximum) break;
        }
        if (matches.length >= maximum) break;
      }
      return listResult("matches", { query: params.query, prefix }, matches);
    },
  });

  pi.registerTool({
    name: "history_list_agents",
    label: "List history agents",
    description: "List agents whose message history is available for this task.",
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "parallel",
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const name = `/${ctx.sessionManager.getSessionId()}`;
      return result({ agents: [{ agent_name: name, current: true }] });
    },
  });

  pi.registerTool({
    name: "history_list_windows",
    label: "List context windows",
    description: "List context windows available in task history, newest first.",
    parameters: Type.Object({ agent_name: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
    executionMode: "parallel",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!isCurrentAgent(params.agent_name, ctx.sessionManager)) return result({ windows: [] });
      const window = state(ctx);
      const items = historyItems(ctx.sessionManager.getBranch(), window);
      const windows = [...window.windows].reverse().map((windowId) => ({
        window_id: windowId,
        item_count: items.filter((item) => item.window_id === windowId).length,
        current: windowId === window.currentWindowId,
      }));
      return listResult("windows", {}, windows);
    },
  });

  pi.registerTool({
    name: "history_list_items",
    label: "List history items",
    description: "List normalized messages and tool activity from task history with optional filters and pagination.",
    parameters: Type.Object({
      agent_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      window_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      role: Type.Optional(Type.Union([Type.Unsafe<Role>({ type: "string", enum: ROLES }), Type.Null()])),
      tool_namespace: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      tool_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      offset: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
      limit: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 100 }), Type.Null()])),
      order: Type.Optional(Type.Union([Type.Unsafe<Order>({ type: "string", enum: ORDERS }), Type.Null()])),
      max_chars_per_item: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 20_000 }), Type.Null()])),
    }),
    executionMode: "parallel",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      let items = selectedItems(ctx, params.agent_name);
      if (params.window_id != null) items = items.filter((item) => item.window_id === params.window_id);
      if (params.role != null) items = items.filter((item) => item.role === params.role);
      if (params.tool_namespace != null) items = items.filter((item) => item.tool_namespace === params.tool_namespace);
      if (params.tool_name != null) items = items.filter((item) => item.tool_name === params.tool_name);
      if ((params.order ?? "oldest_first") === "recent_first") items = [...items].reverse();
      const total = items.length;
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 20;
      const page = items.slice(offset, offset + limit).map((item) => publicItem(item, params.max_chars_per_item ?? 4_000));
      return listResult("items", { total, offset, next_offset: offset + page.length < total ? offset + page.length : null }, page);
    },
  });

  pi.registerTool({
    name: "history_search_contents",
    label: "Search history",
    description: "Search task history for a literal query with optional window, role, tool, ordering, and pagination filters.",
    parameters: Type.Object({
      query: Type.String(),
      agent_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      window_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      role: Type.Optional(Type.Union([Type.Unsafe<Role>({ type: "string", enum: ROLES }), Type.Null()])),
      tool_namespace: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      tool_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      offset: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
      limit: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 100 }), Type.Null()])),
      order: Type.Optional(Type.Union([Type.Unsafe<Order>({ type: "string", enum: ORDERS }), Type.Null()])),
      max_chars_per_item: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 20_000 }), Type.Null()])),
    }),
    executionMode: "parallel",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      let items = selectedItems(ctx, params.agent_name).filter((item) => item.content.includes(params.query));
      if (params.window_id != null) items = items.filter((item) => item.window_id === params.window_id);
      if (params.role != null) items = items.filter((item) => item.role === params.role);
      if (params.tool_namespace != null) items = items.filter((item) => item.tool_namespace === params.tool_namespace);
      if (params.tool_name != null) items = items.filter((item) => item.tool_name === params.tool_name);
      if ((params.order ?? "oldest_first") === "recent_first") items = [...items].reverse();
      const total = items.length;
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 20;
      const page = items.slice(offset, offset + limit).map((item) => publicItem(item, params.max_chars_per_item ?? 4_000));
      return listResult("items", { query: params.query, total, offset, next_offset: offset + page.length < total ? offset + page.length : null }, page);
    },
  });

  pi.registerTool({
    name: "history_read",
    label: "Read history item",
    description: "Read one task-history item by opaque item ID, optionally selecting a character range.",
    parameters: Type.Object({
      item_id: Type.String(),
      offset_chars: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
      limit_chars: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 50_000 }), Type.Null()])),
    }),
    executionMode: "parallel",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const item = selectedItems(ctx).find((candidate) => candidate.item_id === params.item_id);
      if (!item) throw new Error(`History item not found: ${params.item_id}`);
      const offset = params.offset_chars ?? 0;
      const full = chars(item.content);
      const requested = Math.min(params.limit_chars ?? 40_000, 40_000);
      const content = full.slice(offset, offset + requested).join("");
      const page = publicItem({ ...item, content }, requested);
      const emitted = typeof page.content === "string" ? chars(page.content).length : 0;
      const nextOffset = offset + emitted;
      const value = {
        ...page,
        offset_chars: offset,
        total_chars: full.length,
        next_offset_chars: nextOffset < full.length ? nextOffset : null,
      };
      return result(value, item.images);
    },
  });
}
