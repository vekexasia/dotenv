import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sessionEntryToContextMessages, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

export const WINDOW_ENTRY = "pi-codex-context/window-v1";
export const NOTE_ENTRY = "pi-codex-context/note-v1";
export const REMINDER_ENTRY = "pi-codex-context/reminder-v1";
export const RESET_ENTRY = "pi-codex-context/reset-v1";
export const OWNER = "pi-codex-context";
export const MAX_NOTE_BYTES = 1_000_000;

export type WindowReason = "explicit-tool" | "manual" | "threshold" | "overflow" | "tree";

interface WindowRecordBase {
  version: 1;
  firstWindowId: string;
  windowId: string;
}

export type WindowRecord =
  | (WindowRecordBase & { kind: "seed" })
  | (WindowRecordBase & { kind: "commit"; previousWindowId: string; reason: "explicit-tool" })
  | (WindowRecordBase & {
    kind: "anchor";
    previousWindowId: string;
    reason: "manual" | "threshold" | "overflow";
    txId: string;
    carryStartId?: string;
  })
  | (WindowRecordBase & {
    kind: "reanchor";
    previousWindowId?: string;
    reason: "tree";
    targetId: string;
    targetParentId: string | null;
    carryStartId?: string;
  });

export interface ResetPrepareRecord {
  version: 1;
  kind: "prepare";
  toolCallId: string;
  assistantEntryId: string;
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

type BoundaryBase = {
  entryId: string;
  entryIndex: number;
  windowId: string;
  carryStartId?: string;
  carryStartIndex?: number;
};

type Boundary =
  | (BoundaryBase & { kind: "commit"; previousWindowId: string })
  | (BoundaryBase & { kind: "anchor"; previousWindowId: string })
  | (BoundaryBase & { kind: "reanchor"; previousWindowId?: string; targetParentId: string | null });

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

export interface ReplayCounters {
  entriesScanned: number;
  noteRecordsScanned: number;
  noteBytesCopied: number;
  pathSteps: number;
}

export interface ReplayWindowMarker {
  entry: Extract<SessionEntry, { type: "custom" }> & { data: WindowRecord };
  index: number;
}

export interface ReplayIndex {
  entries: SessionEntry[];
  byId: Map<string, SessionEntry>;
  indexById: Map<string, number>;
  noteRecords: Array<{ entry: SessionEntry; record: NoteRecord }>;
  windowMarkers: ReplayWindowMarker[];
  duplicateEntryIds: string[];
  entryStarts: Map<string, number>;
  entryEnds: Map<string, number>;
  counters: ReplayCounters;
}

export interface ReplayIndexOptions {
  notes?: boolean;
  ancestors?: boolean;
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

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasOnlyKeys(item: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(item).every((key) => allowed.has(key));
}

export function isWindowRecord(value: unknown): value is WindowRecord {
  const item = object(value);
  if (!item || item.version !== 1 || !nonEmptyString(item.firstWindowId) || !nonEmptyString(item.windowId)) return false;
  if (item.kind === "seed") {
    return hasOnlyKeys(item, ["version", "kind", "firstWindowId", "windowId"]) && item.firstWindowId === item.windowId;
  }
  if (item.kind === "commit") {
    return hasOnlyKeys(item, ["version", "kind", "firstWindowId", "previousWindowId", "windowId", "reason"]) &&
      nonEmptyString(item.previousWindowId) && item.reason === "explicit-tool";
  }
  if (item.kind === "anchor") {
    return hasOnlyKeys(item, ["version", "kind", "firstWindowId", "previousWindowId", "windowId", "reason", "txId", "carryStartId"]) &&
      nonEmptyString(item.previousWindowId) &&
      (item.reason === "manual" || item.reason === "threshold" || item.reason === "overflow") &&
      nonEmptyString(item.txId) &&
      (item.carryStartId === undefined || nonEmptyString(item.carryStartId));
  }
  if (item.kind === "reanchor") {
    return hasOnlyKeys(item, ["version", "kind", "firstWindowId", "previousWindowId", "windowId", "reason", "targetId", "targetParentId", "carryStartId"]) &&
      (item.previousWindowId === undefined || nonEmptyString(item.previousWindowId)) &&
      item.reason === "tree" && nonEmptyString(item.targetId) &&
      (item.targetParentId === null || nonEmptyString(item.targetParentId)) &&
      (item.carryStartId === undefined || nonEmptyString(item.carryStartId));
  }
  return false;
}

export function isWindowDetails(value: unknown): value is WindowDetails {
  const item = object(value);
  return (
    !!item &&
    hasOnlyKeys(item, ["owner", "version", "kind", "txId", "boundaryId", "firstWindowId", "previousWindowId", "windowId"]) &&
    item.owner === OWNER &&
    item.version === 1 &&
    (item.kind === "rollover" || item.kind === "materialize") &&
    nonEmptyString(item.txId) &&
    nonEmptyString(item.boundaryId) &&
    nonEmptyString(item.firstWindowId) &&
    (item.previousWindowId === null || nonEmptyString(item.previousWindowId)) &&
    nonEmptyString(item.windowId)
  );
}

export function isResetPrepare(value: unknown): value is ResetPrepareRecord {
  const item = object(value);
  return !!item && hasOnlyKeys(item, ["version", "kind", "toolCallId", "assistantEntryId"]) &&
    item.version === 1 && item.kind === "prepare" && nonEmptyString(item.toolCallId) && nonEmptyString(item.assistantEntryId);
}

function validAnchor(entries: SessionEntry[], index: number, record: Extract<WindowRecord, { kind: "anchor" }>): boolean {
  const compaction = entries[index + 1];
  return compaction?.type === "compaction" &&
    isWindowDetails(compaction.details) &&
    compaction.details.kind === "rollover" &&
    compaction.details.txId === record.txId &&
    compaction.details.boundaryId === entries[index]!.id &&
    compaction.details.firstWindowId === record.firstWindowId &&
    compaction.details.previousWindowId === record.previousWindowId &&
    compaction.details.windowId === record.windowId;
}

export function deriveWindowState(entries: SessionEntry[]): WindowState | undefined {
  const replayIndex = buildReplayIndex(entries);
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
    if (record.firstWindowId !== seed.data.firstWindowId) continue;

    if (record.kind === "reanchor") {
      const targetIndex = windows.indexOf(record.windowId);
      if (targetIndex < 0 && record.previousWindowId !== current) continue;
      if (targetIndex < 0) windows.push(record.windowId);
      const resolvedIndex = windows.indexOf(record.windowId);
      const logicalPrevious = resolvedIndex > 0 ? windows[resolvedIndex - 1] : undefined;
      if (record.previousWindowId !== logicalPrevious) continue;
      const carryStartIndex = record.carryStartId
        ? (replayIndex.indexById.get(record.carryStartId) ?? -1) < index
          ? replayIndex.indexById.get(record.carryStartId)!
          : -1
        : -1;
      boundaries.push({
        entryId: entry.id,
        entryIndex: index,
        carryStartId: record.carryStartId,
        carryStartIndex: carryStartIndex >= 0 ? carryStartIndex : undefined,
        previousWindowId: logicalPrevious,
        windowId: record.windowId,
        kind: record.kind,
        targetParentId: record.targetParentId,
      });
      previous = logicalPrevious;
      current = record.windowId;
      continue;
    }

    if (record.previousWindowId !== current) continue;
    if (record.kind === "anchor" && !validAnchor(entries, index, record)) continue;
    const carryStartId = record.kind === "anchor" ? record.carryStartId : undefined;
    const carryStartIndex = carryStartId
      ? (replayIndex.indexById.get(carryStartId) ?? -1) < index
        ? replayIndex.indexById.get(carryStartId)!
        : -1
      : -1;
    if (carryStartId && carryStartIndex < 0) continue;
    const boundary: Boundary = {
      entryId: entry.id,
      entryIndex: index,
      carryStartId,
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
  if (boundary.carryStartId && boundary.kind !== "reanchor" && (carryIndex < 0 || carryIndex >= markerIndex)) {
    throw new Error("Carried input was discarded");
  }
  let carried: SessionEntry[] = [];
  if (carryIndex >= 0) {
    carried = entries.slice(carryIndex, markerIndex);
  } else if (boundary.kind === "reanchor") {
    if (boundary.targetParentId === null) {
      carried = entries.slice(0, markerIndex).filter((entry) => entry.type === "branch_summary");
    } else {
      const parentIndex = entries.findIndex((entry) => entry.id === boundary.targetParentId);
      if (parentIndex < 0) throw new Error("Tree re-anchor parent was discarded");
      carried = entries.slice(parentIndex + 1, markerIndex);
    }
  }
  return [...carried, ...entries.slice(markerIndex + 1)];
}

export interface WindowOrigin {
  windowId: string;
  previousWindowId?: string;
  carryStartId?: string;
}

function pathToEntry(index: ReplayIndex, entryId: string): SessionEntry[] | undefined {
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let current: SessionEntry | undefined = index.byId.get(entryId);
  while (current) {
    index.counters.pathSteps++;
    if (seen.has(current.id)) return undefined;
    seen.add(current.id);
    path.push(current);
    current = current.parentId === null ? undefined : index.byId.get(current.parentId);
    if (current === undefined && path.at(-1)!.parentId !== null) return undefined;
  }
  path.reverse();
  return path;
}

function isAncestor(index: ReplayIndex, ancestorId: string, descendantId: string): boolean {
  const ancestorStart = index.entryStarts.get(ancestorId);
  const ancestorEnd = index.entryEnds.get(ancestorId);
  const descendantStart = index.entryStarts.get(descendantId);
  const descendantEnd = index.entryEnds.get(descendantId);
  if (ancestorStart !== undefined && ancestorEnd !== undefined && descendantStart !== undefined && descendantEnd !== undefined) {
    return ancestorStart <= descendantStart && descendantEnd <= ancestorEnd;
  }
  const path = pathToEntry(index, descendantId);
  return path?.some((entry) => entry.id === ancestorId) ?? false;
}

function windowOriginForEntryWithIndex(replayIndex: ReplayIndex, entryId: string): WindowOrigin | undefined {
  const targetIndex = replayIndex.indexById.get(entryId);
  if (targetIndex === undefined || targetIndex >= replayIndex.entries.length) return undefined;

  let origin: WindowOrigin | undefined;
  let firstWindowId: string | undefined;
  const markers = replayIndex.windowMarkers.filter((marker) => marker.index < replayIndex.entries.length);
  for (const marker of markers) {
    const entry = marker.entry;
    if (!isAncestor(replayIndex, entry.id, entryId)) continue;
    const record = entry.data;
    if (record.kind === "seed") {
      if (firstWindowId === undefined) {
        firstWindowId = record.firstWindowId;
        origin = { windowId: record.windowId };
      }
      continue;
    }
    if (firstWindowId === undefined || record.firstWindowId !== firstWindowId) continue;
    if (record.kind === "anchor" && !validAnchor(replayIndex.entries, marker.index, record)) continue;
    if (record.kind === "reanchor") {
      origin = {
        windowId: record.windowId,
        previousWindowId: record.previousWindowId,
        carryStartId: record.carryStartId,
      };
      continue;
    }
    if (origin && record.previousWindowId === origin.windowId) {
      origin = {
        windowId: record.windowId,
        previousWindowId: record.previousWindowId,
        carryStartId: record.kind === "anchor" ? record.carryStartId : undefined,
      };
    }
  }
  if (!origin) return undefined;

  // The first rollover that carries an entry is its stable logical origin;
  // later rollovers may carry the same batch on a descendant branch.
  for (const marker of markers) {
    const entry = marker.entry;
    if (entry.data.kind !== "anchor") continue;
    const record = entry.data;
    if (!validAnchor(replayIndex.entries, marker.index, record)) continue;
    const carryIndex = record.carryStartId ? replayIndex.indexById.get(record.carryStartId) ?? -1 : -1;
    if (carryIndex < 0 || targetIndex < carryIndex || targetIndex >= marker.index) continue;
    if (!isAncestor(replayIndex, entryId, entry.id)) continue;
    return {
      windowId: record.windowId,
      previousWindowId: record.previousWindowId,
      carryStartId: record.carryStartId,
    };
  }
  return origin;
}

function ownedWindowMarker(entry: SessionEntry): entry is Extract<SessionEntry, { type: "custom" }> & { data: WindowRecord } {
  return entry.type === "custom" && entry.customType === WINDOW_ENTRY && isWindowRecord(entry.data);
}

export function windowOriginForEntry(
  entries: SessionEntry[],
  entryId: string,
  byId?: Map<string, SessionEntry>,
  indexById?: Map<string, number>,
  entryStarts?: Map<string, number>,
  entryEnds?: Map<string, number>,
  windowMarkers?: ReplayWindowMarker[],
): WindowOrigin | undefined {
  const index: ReplayIndex = byId && indexById
    ? {
      entries,
      byId,
      indexById,
      noteRecords: [],
      windowMarkers: windowMarkers ?? entries.flatMap((entry, index) => ownedWindowMarker(entry) ? [{ entry, index }] : []),
      duplicateEntryIds: [],
      entryStarts: entryStarts ?? new Map(),
      entryEnds: entryEnds ?? new Map(),
      counters: { entriesScanned: 0, noteRecordsScanned: 0, noteBytesCopied: 0, pathSteps: 0 },
    }
    : buildReplayIndex(entries, { ancestors: true });
  return windowOriginForEntryWithIndex(index, entryId);
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

export function buildReplayIndex(entries: SessionEntry[], options: ReplayIndexOptions = {}): ReplayIndex {
  const byId = new Map<string, SessionEntry>();
  const indexById = new Map<string, number>();
  const noteRecords: Array<{ entry: SessionEntry; record: NoteRecord }> = [];
  const windowMarkers: ReplayWindowMarker[] = [];
  const duplicateEntryIds: string[] = [];
  const duplicateIds = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (byId.has(entry.id)) {
      if (!duplicateIds.has(entry.id)) duplicateEntryIds.push(entry.id);
      duplicateIds.add(entry.id);
    }
    byId.set(entry.id, entry);
    indexById.set(entry.id, index);
    if (options.notes && entry.type === "custom" && entry.customType === NOTE_ENTRY && isNoteRecord(entry.data)) {
      noteRecords.push({ entry, record: entry.data });
    }
    if (options.ancestors && ownedWindowMarker(entry)) {
      windowMarkers.push({ entry, index });
    }
  }

  const entryStarts = new Map<string, number>();
  const entryEnds = new Map<string, number>();
  if (options.ancestors) {
    const children = new Map<string, string[]>();
    const roots: string[] = [];
    for (const entry of entries) {
      if (entry.parentId === null) {
        roots.push(entry.id);
      } else if (byId.has(entry.parentId)) {
        const siblings = children.get(entry.parentId) ?? [];
        siblings.push(entry.id);
        children.set(entry.parentId, siblings);
      }
    }
    let traversalIndex = 0;
    const stack: Array<{ id: string; exit: boolean }> = roots.reverse().map((id) => ({ id, exit: false }));
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.exit) {
        entryEnds.set(current.id, traversalIndex);
        continue;
      }
      if (entryStarts.has(current.id)) continue;
      entryStarts.set(current.id, traversalIndex++);
      stack.push({ id: current.id, exit: true });
      const descendants = children.get(current.id) ?? [];
      for (let index = descendants.length - 1; index >= 0; index--) {
        stack.push({ id: descendants[index]!, exit: false });
      }
    }
  }

  return {
    entries,
    byId,
    indexById,
    noteRecords,
    windowMarkers,
    duplicateEntryIds,
    entryStarts,
    entryEnds,
    counters: { entriesScanned: entries.length, noteRecordsScanned: 0, noteBytesCopied: 0, pathSteps: 0 },
  };
}

function aggregateNotes(index: ReplayIndex): NoteFile[] {
  const files = new Map<string, { chunks: string[]; bytes: number; created_at: string; updated_at: string }>();
  for (const { entry, record } of index.noteRecords) {
    index.counters.noteRecordsScanned++;
    const old = files.get(record.path);
    const chunks = record.op === "append" ? (old?.chunks ?? []) : [];
    chunks.push(record.text);
    const bytes = record.op === "append" ? (old?.bytes ?? 0) + Buffer.byteLength(record.text) : Buffer.byteLength(record.text);
    files.set(record.path, {
      chunks,
      bytes,
      created_at: old?.created_at ?? entry.timestamp,
      updated_at: entry.timestamp,
    });
  }
  return [...files].map(([path, file]) => {
    const text = file.chunks.join("");
    index.counters.noteBytesCopied += file.bytes;
    return { path, text, bytes: file.bytes, created_at: file.created_at, updated_at: file.updated_at };
  });
}

export function readNotesIndexed(index: ReplayIndex): NoteFile[] {
  return aggregateNotes(index);
}

export function readNotes(entries: SessionEntry[]): NoteFile[] {
  return readNotesIndexed(buildReplayIndex(entries, { notes: true }));
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

function windowAssignments(entries: SessionEntry[], state: WindowState, replayIndex: ReplayIndex): string[] {
  const assigned = Array(entries.length).fill(state.firstWindowId) as string[];
  const carried = new Set<number>();
  const assignCarried = (index: number, windowId: string) => {
    if (!carried.has(index)) {
      assigned[index] = windowId;
      carried.add(index);
    }
  };
  let current = state.firstWindowId;
  let boundaryIndex = 0;
  for (let index = 0; index < entries.length; index++) {
    const boundary = state.boundaries[boundaryIndex];
    if (boundary?.entryIndex === index) {
      if (boundary.carryStartIndex !== undefined) {
        for (let carriedIndex = boundary.carryStartIndex; carriedIndex < index; carriedIndex++) {
          assignCarried(carriedIndex, boundary.windowId);
        }
      } else if (boundary.kind === "reanchor") {
        if (boundary.targetParentId === null) {
          for (let carriedIndex = 0; carriedIndex < index; carriedIndex++) {
            if (entries[carriedIndex]!.type === "branch_summary") assignCarried(carriedIndex, boundary.windowId);
          }
        } else {
          const parentIndex = replayIndex.indexById.get(boundary.targetParentId);
          if (parentIndex === undefined) throw new Error("Tree re-anchor parent was discarded");
          for (let carriedIndex = parentIndex + 1; carriedIndex < index; carriedIndex++) {
            assignCarried(carriedIndex, boundary.windowId);
          }
        }
      }
      current = boundary.windowId;
      boundaryIndex++;
    }
    assigned[index] = current;
  }
  return assigned;
}

export function historyItems(entries: SessionEntry[], state: WindowState): HistoryItem[] {
  const replayIndex = buildReplayIndex(entries);
  const assignments = windowAssignments(entries, state, replayIndex);
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
