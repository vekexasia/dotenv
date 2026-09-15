import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sessionEntryToContextMessages, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

export const WINDOW_ENTRY = "pi-codex-context/window-v1";
export const NOTE_ENTRY = "pi-codex-context/note-v1";
export const REMINDER_ENTRY = "pi-codex-context/reminder-v1";
export const OWNER = "pi-codex-context";
export const MAX_NOTE_BYTES = 1_000_000;

export type WindowReason = "explicit-tool" | "manual" | "threshold" | "overflow";

export interface WindowRecord {
  version: 1;
  kind: "seed" | "commit" | "anchor";
  firstWindowId: string;
  previousWindowId?: string;
  windowId: string;
  reason?: WindowReason;
  txId?: string;
  carryStartId?: string;
}

export interface WindowDetails {
  owner: typeof OWNER;
  version: 1;
  kind: "rollover" | "materialize";
  txId: string;
  boundaryId: string;
  firstWindowId: string;
  previousWindowId: string | null;
  windowId: string;
}

interface Boundary {
  entryId: string;
  entryIndex: number;
  carryStartId?: string;
  carryStartIndex?: number;
  previousWindowId: string;
  windowId: string;
  kind: "commit" | "anchor";
}

export interface WindowState {
  firstWindowId: string;
  currentWindowId: string;
  previousWindowId?: string;
  boundaries: Boundary[];
  windows: string[];
  materializedBoundaryIds: Set<string>;
}

interface NoteRecord {
  version: 1;
  op: "write" | "append";
  path: string;
  text: string;
}

export interface NoteFile {
  path: string;
  text: string;
  bytes: number;
  created_at: string;
  updated_at: string;
}

export interface HistoryItem {
  window_id: string;
  item_id: string;
  ordinal: number;
  created_at: string;
  role: "user" | "assistant" | "tool" | "developer";
  tool_namespace: string | null;
  tool_name: string | null;
  content: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
}

export type ReadonlySessionManager = ExtensionContext["sessionManager"];

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isWindowRecord(value: unknown): value is WindowRecord {
  const item = object(value);
  if (
    item?.version !== 1 ||
    (item.kind !== "seed" && item.kind !== "commit" && item.kind !== "anchor") ||
    typeof item.firstWindowId !== "string" ||
    typeof item.windowId !== "string"
  ) return false;
  if (item.kind === "seed") return item.firstWindowId === item.windowId;
  return (
    typeof item.previousWindowId === "string" &&
    typeof item.reason === "string" &&
    (item.kind === "commit" || typeof item.txId === "string") &&
    (item.carryStartId === undefined || typeof item.carryStartId === "string")
  );
}

export function isWindowDetails(value: unknown): value is WindowDetails {
  const item = object(value);
  return (
    item?.owner === OWNER &&
    item.version === 1 &&
    (item.kind === "rollover" || item.kind === "materialize") &&
    typeof item.txId === "string" &&
    typeof item.boundaryId === "string" &&
    typeof item.firstWindowId === "string" &&
    (item.previousWindowId === null || typeof item.previousWindowId === "string") &&
    typeof item.windowId === "string"
  );
}

function validAnchor(entries: SessionEntry[], index: number, record: WindowRecord): boolean {
  for (let i = index + 1; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.type === "custom" && entry.customType === WINDOW_ENTRY) return false;
    if (entry.type !== "compaction") continue;
    return (
      isWindowDetails(entry.details) &&
      entry.details.kind === "rollover" &&
      entry.details.txId === record.txId &&
      entry.details.boundaryId === entries[index]!.id &&
      entry.details.windowId === record.windowId
    );
  }
  return false;
}

export function deriveWindowState(entries: SessionEntry[]): WindowState | undefined {
  const seedIndex = entries.findIndex(
    (entry) => entry.type === "custom" && entry.customType === WINDOW_ENTRY && isWindowRecord(entry.data) && entry.data.kind === "seed",
  );
  if (seedIndex < 0) return undefined;
  const seed = entries[seedIndex]!;
  if (seed.type !== "custom" || !isWindowRecord(seed.data)) return undefined;

  const boundaries: Boundary[] = [];
  const windows = [seed.data.windowId];
  const materializedBoundaryIds = new Set<string>();
  let current = seed.data.windowId;
  let previous: string | undefined;

  for (let index = seedIndex + 1; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.type === "compaction" && isWindowDetails(entry.details)) {
      materializedBoundaryIds.add(entry.details.boundaryId);
      continue;
    }
    if (entry.type !== "custom" || entry.customType !== WINDOW_ENTRY || !isWindowRecord(entry.data)) continue;
    const record = entry.data;
    if (record.kind === "seed") continue;
    if (record.firstWindowId !== seed.data.firstWindowId || record.previousWindowId !== current) continue;
    if (record.kind === "anchor" && !validAnchor(entries, index, record)) continue;
    const carryStartIndex = record.carryStartId
      ? entries.findIndex((candidate, candidateIndex) => candidateIndex < index && candidate.id === record.carryStartId)
      : -1;
    if (record.carryStartId && carryStartIndex < 0) continue;
    const boundary: Boundary = {
      entryId: entry.id,
      entryIndex: index,
      carryStartId: record.carryStartId,
      carryStartIndex: carryStartIndex >= 0 ? carryStartIndex : undefined,
      previousWindowId: current,
      windowId: record.windowId,
      kind: record.kind,
    };
    boundaries.push(boundary);
    windows.push(record.windowId);
    previous = current;
    current = record.windowId;
  }

  return {
    firstWindowId: seed.data.firstWindowId,
    currentWindowId: current,
    previousWindowId: previous,
    boundaries,
    windows,
    materializedBoundaryIds,
  };
}

export function currentWindowEntries(entries: SessionEntry[], state: WindowState): SessionEntry[] {
  const boundary = state.boundaries.at(-1);
  if (!boundary) return entries;
  const markerIndex = entries.findIndex((entry) => entry.id === boundary.entryId);
  if (markerIndex < 0) throw new Error("Current context window boundary was discarded");
  const carryIndex = boundary.carryStartId
    ? entries.findIndex((entry) => entry.id === boundary.carryStartId)
    : -1;
  if (boundary.carryStartId && (carryIndex < 0 || carryIndex >= markerIndex)) throw new Error("Carried input was discarded");
  const carried = carryIndex < 0 ? [] : entries.slice(carryIndex, markerIndex);
  return [...carried, ...entries.slice(markerIndex + 1)];
}

export function entryToMessages(entry: SessionEntry): AgentMessage[] {
  if (entry.type === "compaction" && isWindowDetails(entry.details)) return [];
  return sessionEntryToContextMessages(entry).filter((message) => {
    if (message.role === "assistant") return message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "length";
    return message.role !== "toolResult" || !message.isError ||
      !message.content.some((part) => part.type === "text" && part.text.includes("truncated by the output token limit"));
  });
}

export function normalizeNotePath(path: string, sessionId: string, allowRoot = false): string {
  if (path.includes("\0") || path.includes("\\")) throw new Error("Invalid virtual note path");
  let relative = path;
  if (path.startsWith("/")) {
    const root = `/${sessionId}/notes`;
    if (path !== root && !path.startsWith(root + "/")) throw new Error("Note path belongs to another task");
    relative = path.slice(root.length).replace(/^\//, "");
  }
  if (!relative) {
    if (allowRoot) return "";
    throw new Error("Note path must name a file");
  }
  if (Buffer.byteLength(relative) > 4_096) throw new Error("Note path is too long");
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Note paths do not support empty, '.', or '..' components");
  return parts.join("/");
}

function isNoteRecord(value: unknown): value is NoteRecord {
  const item = object(value);
  return item?.version === 1 && (item.op === "write" || item.op === "append") && typeof item.path === "string" && typeof item.text === "string";
}

export function readNotes(entries: SessionEntry[]): NoteFile[] {
  const files = new Map<string, NoteFile>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== NOTE_ENTRY || !isNoteRecord(entry.data)) continue;
    const old = files.get(entry.data.path);
    const text = entry.data.op === "append" ? (old?.text ?? "") + entry.data.text : entry.data.text;
    files.set(entry.data.path, {
      path: entry.data.path,
      text,
      bytes: Buffer.byteLength(text),
      created_at: old?.created_at ?? entry.timestamp,
      updated_at: entry.timestamp,
    });
  }
  return [...files.values()];
}

export function saveNote(
  pi: Pick<ExtensionAPI, "appendEntry">,
  manager: ReadonlySessionManager,
  op: "write" | "append",
  rawPath: string,
  text: string,
): NoteFile {
  const path = normalizeNotePath(rawPath, manager.getSessionId());
  const old = readNotes(manager.getBranch()).find((file) => file.path === path);
  const next = op === "append" ? (old?.text ?? "") + text : text;
  if (Buffer.byteLength(next) > MAX_NOTE_BYTES) throw new Error(`Note exceeds ${MAX_NOTE_BYTES} UTF-8 bytes`);
  pi.appendEntry(NOTE_ENTRY, { version: 1, op, path, text });
  return {
    path,
    text: next,
    bytes: Buffer.byteLength(next),
    created_at: old?.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function contentParts(content: unknown): { text: string; images: HistoryItem["images"] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };
  const text: string[] = [];
  const images: HistoryItem["images"] = [];
  for (const part of content) {
    const item = object(part);
    if (item?.type === "text" && typeof item.text === "string") text.push(item.text);
    if (item?.type === "thinking" && typeof item.thinking === "string") text.push(`[thinking]\n${item.thinking}`);
    if (item?.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      images.push({ type: "image", data: item.data, mimeType: item.mimeType });
      text.push(`[image: ${item.mimeType}]`);
    }
  }
  return { text: text.join("\n"), images };
}

function windowAssignments(entries: SessionEntry[], state: WindowState): string[] {
  const assigned = Array(entries.length).fill(state.firstWindowId) as string[];
  let current = state.firstWindowId;
  let boundaryIndex = 0;
  for (let index = 0; index < entries.length; index++) {
    const boundary = state.boundaries[boundaryIndex];
    if (boundary?.entryIndex === index) {
      if (boundary.carryStartIndex !== undefined) {
        for (let carried = boundary.carryStartIndex; carried < index; carried++) assigned[carried] = boundary.windowId;
      }
      current = boundary.windowId;
      boundaryIndex++;
    }
    assigned[index] = current;
  }
  return assigned;
}

export function historyItems(entries: SessionEntry[], state: WindowState): HistoryItem[] {
  const assignments = windowAssignments(entries, state);
  const items: HistoryItem[] = [];
  const push = (entry: SessionEntry, entryIndex: number, suffix: string, role: HistoryItem["role"], content: string, toolName: string | null, images: HistoryItem["images"] = []) => {
    if (!content && images.length === 0) return;
    items.push({
      window_id: assignments[entryIndex]!,
      item_id: `${entry.id}:${suffix}`,
      ordinal: items.length,
      created_at: entry.timestamp,
      role,
      tool_namespace: null,
      tool_name: toolName,
      content,
      images,
    });
  };

  entries.forEach((entry, index) => {
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "user") {
        const content = contentParts(message.content);
        push(entry, index, "message", "user", content.text, null, content.images);
      } else if (message.role === "assistant") {
        const narrative = contentParts(message.content);
        push(entry, index, "message", "assistant", narrative.text, null, narrative.images);
        message.content.forEach((part, partIndex) => {
          if (part.type === "toolCall") push(entry, index, `call-${partIndex}`, "assistant", JSON.stringify(part.arguments), part.name);
        });
      } else if (message.role === "toolResult") {
        const content = contentParts(message.content);
        push(entry, index, "result", "tool", content.text, message.toolName, content.images);
      } else if (message.role === "bashExecution") {
        push(entry, index, "result", "tool", `$ ${message.command}\n${message.output}`, "bash");
      } else if (message.role === "custom") {
        const content = contentParts(message.content);
        push(entry, index, "message", "developer", content.text, null, content.images);
      } else if (message.role === "branchSummary" || message.role === "compactionSummary") {
        push(entry, index, "summary", "developer", message.summary, null);
      }
      return;
    }
    if (entry.type === "custom_message") {
      const content = contentParts(entry.content);
      push(entry, index, "message", "developer", content.text, null, content.images);
    } else if (entry.type === "branch_summary") {
      push(entry, index, "summary", "developer", entry.summary, null);
    } else if (entry.type === "compaction" && !isWindowDetails(entry.details)) {
      push(entry, index, "summary", "developer", entry.summary, null);
    }
  });
  return items;
}

export function isCurrentAgent(agentName: string | null | undefined, manager: ReadonlySessionManager): boolean {
  return agentName == null || agentName === manager.getSessionId() || agentName === `/${manager.getSessionId()}`;
}
