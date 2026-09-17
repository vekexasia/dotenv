import { createHash, randomUUID } from "node:crypto";
import { calculateContextTokens, estimateTokens, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildReplayIndex,
  currentWindowEntries,
  deriveWindowState,
  entryToMessages,
  isResetPrepare,
  isWindowDetails,
  isWindowRecord,
  OWNER,
  RESET_ENTRY,
  WINDOW_ENTRY,
  type ReadonlySessionManager,
  type ReplayIndex,
  type ResetPrepareRecord,
  type WindowDetails,
  type WindowReason,
  type WindowRecord,
  type WindowState,
  windowOriginForEntry,
} from "./store.js";

const ERROR = Symbol.for("pi-codex-context.error");
export const DEFAULT_STATIC_OVERHEAD = 12_000;
const STATIC_ESTIMATE_CACHE_LIMIT = 32;
const staticEstimateCache = new Map<string, number>();

interface MarkedManager extends ReadonlySessionManager {
  [ERROR]?: string;
}

export function poison(manager: ReadonlySessionManager, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  Object.defineProperty(manager, ERROR, { configurable: true, value: message || "unknown state error" });
}

export function poisonReason(manager: ReadonlySessionManager): string | undefined {
  return (manager as MarkedManager)[ERROR];
}

export function staticOverhead(pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">, ctx: ExtensionContext): number {
  const prompt = ctx.getSystemPrompt();
  const active = new Set(pi.getActiveTools());
  const tools = pi.getAllTools()
    .filter((tool) => active.has(tool.name))
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, promptGuidelines: tool.promptGuidelines }));
  const key = createHash("sha256").update(JSON.stringify([ctx.model?.provider, ctx.model?.id, prompt, tools])).digest("hex");
  const cached = staticEstimateCache.get(key);
  if (cached !== undefined) return cached;
  const estimated = prompt || tools.length > 0
    ? estimateTokens({ role: "user", content: `${prompt}\n${JSON.stringify(tools)}`, timestamp: 0 })
    : DEFAULT_STATIC_OVERHEAD;
  const value = estimated > 0 ? estimated : DEFAULT_STATIC_OVERHEAD;
  if (staticEstimateCache.size >= STATIC_ESTIMATE_CACHE_LIMIT) {
    staticEstimateCache.delete(staticEstimateCache.keys().next().value!);
  }
  staticEstimateCache.set(key, value);
  return value;
}

function appendWindowRecord(pi: Pick<ExtensionAPI, "appendEntry">, manager: ReadonlySessionManager, record: WindowRecord): string {
  pi.appendEntry(WINDOW_ENTRY, record);
  const id = manager.getLeafId();
  if (!id) throw new Error("Window checkpoint was not persisted");
  const entry = manager.getEntry(id);
  if (entry?.type !== "custom" || entry.customType !== WINDOW_ENTRY || !isWindowRecord(entry.data) || entry.data.windowId !== record.windowId) {
    throw new Error("Window checkpoint was not persisted");
  }
  return id;
}

export function ensureSeed(pi: Pick<ExtensionAPI, "appendEntry">, manager: ReadonlySessionManager): WindowState {
  const existing = deriveWindowState(manager.getBranch());
  if (existing) return existing;
  const windowId = randomUUID();
  appendWindowRecord(pi, manager, {
    version: 1,
    kind: "seed",
    firstWindowId: windowId,
    windowId,
  });
  const state = deriveWindowState(manager.getBranch());
  if (!state) throw new Error("Initial context window was not persisted");
  return state;
}

export function reanchorTree(
  pi: Pick<ExtensionAPI, "appendEntry">,
  manager: ReadonlySessionManager,
  targetId: string,
): WindowState {
  const state = ensureSeed(pi, manager);
  const target = manager.getEntry(targetId);
  const origin = windowOriginForEntry(manager.getEntries(), targetId);
  if (!target || !origin || origin.windowId === state.currentWindowId) return state;
  appendWindowRecord(pi, manager, {
    version: 1,
    kind: "reanchor",
    firstWindowId: state.firstWindowId,
    previousWindowId: origin.previousWindowId,
    windowId: origin.windowId,
    reason: "tree",
    targetId,
    targetParentId: target.parentId,
    carryStartId: origin.carryStartId,
  });
  const reanchored = deriveWindowState(manager.getBranch());
  if (!reanchored || reanchored.currentWindowId !== origin.windowId) throw new Error("Tree context window re-anchor did not persist");
  return reanchored;
}

export function prepareExplicitReset(
  pi: Pick<ExtensionAPI, "appendEntry">,
  manager: ReadonlySessionManager,
  toolCallId: string,
): void {
  ensureSeed(pi, manager);
  const branch = manager.getBranch();
  const assistant = [...branch].reverse().find(
    (entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some(
      (part) => part.type === "toolCall" && part.id === toolCallId && part.name === "new_context",
    ),
  );
  if (!assistant) throw new Error("new_context assistant entry is unavailable");
  if (branch.some((entry) => entry.type === "custom" && entry.customType === RESET_ENTRY && isResetPrepare(entry.data) &&
    entry.data.toolCallId === toolCallId && entry.data.assistantEntryId === assistant.id)) return;
  const record: ResetPrepareRecord = { version: 1, kind: "prepare", toolCallId, assistantEntryId: assistant.id };
  pi.appendEntry(RESET_ENTRY, record);
  if (!manager.getLeafId()) throw new Error("Reset preparation was not persisted");
}

function successfulResetResult(branch: SessionEntry[], prepare: ResetPrepareRecord): boolean {
  const assistant = branch.find((entry) => entry.id === prepare.assistantEntryId);
  if (assistant?.type !== "message" || assistant.message.role !== "assistant" ||
    !assistant.message.content.some((part) => part.type === "toolCall" && part.id === prepare.toolCallId && part.name === "new_context")) return false;
  return branch.some((entry) => entry.type === "message" && entry.message.role === "toolResult" &&
    entry.message.toolCallId === prepare.toolCallId && !entry.message.isError);
}

export function recoverExplicitReset(
  pi: Pick<ExtensionAPI, "appendEntry">,
  manager: ReadonlySessionManager,
): boolean {
  const branch = manager.getBranch();
  for (const [index, entry] of branch.entries()) {
    if (entry.type !== "custom" || entry.customType !== RESET_ENTRY || !isResetPrepare(entry.data)) continue;
    if (!successfulResetResult(branch, entry.data)) continue;
    const before = deriveWindowState(branch.slice(0, index));
    const current = deriveWindowState(branch);
    if (!before || !current || current.currentWindowId !== before.currentWindowId) continue;
    const committed = branch.slice(index + 1).some(
      (candidate) => candidate.type === "custom" && candidate.customType === WINDOW_ENTRY && isWindowRecord(candidate.data) &&
        candidate.data.kind === "commit" && candidate.data.firstWindowId === before.firstWindowId && candidate.data.previousWindowId === before.currentWindowId,
    );
    if (committed) continue;
    commitExplicitWindow(pi, manager);
    return true;
  }
  return false;
}

export function commitExplicitWindow(
  pi: Pick<ExtensionAPI, "appendEntry">,
  manager: ReadonlySessionManager,
): WindowState {
  const state = ensureSeed(pi, manager);
  const windowId = randomUUID();
  appendWindowRecord(pi, manager, {
    version: 1,
    kind: "commit",
    firstWindowId: state.firstWindowId,
    previousWindowId: state.currentWindowId,
    windowId,
    reason: "explicit-tool",
  });
  const committed = deriveWindowState(manager.getBranch());
  if (!committed || committed.currentWindowId !== windowId) throw new Error("Explicit context rollover did not commit");
  return committed;
}

export function projectedMessages(manager: ReadonlySessionManager, state: WindowState): AgentMessage[] {
  return currentWindowEntries(manager.buildContextEntries(), state).flatMap(entryToMessages);
}

export function hasValidAssistantUsage(messages: AgentMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") continue;
    return message.usage !== undefined && calculateContextTokens(message.usage) > 0;
  }
  return false;
}

function hasToolCall(entry: SessionEntry): boolean {
  return entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((part) => part.type === "toolCall");
}

function failedAssistant(entry: SessionEntry): boolean {
  return entry.type === "message" && entry.message.role === "assistant" &&
    (entry.message.stopReason === "error" || entry.message.stopReason === "aborted" || entry.message.stopReason === "length");
}

export function findUnconsumedStart(entries: SessionEntry[]): string | undefined {
  let latestSuccessfulAssistant = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type === "message" && entry.message.role === "assistant" && !failedAssistant(entry)) {
      latestSuccessfulAssistant = index;
      break;
    }
  }
  if (latestSuccessfulAssistant >= 0 && hasToolCall(entries[latestSuccessfulAssistant]!)) {
    return entries[latestSuccessfulAssistant]!.id;
  }
  for (let index = latestSuccessfulAssistant + 1; index < entries.length; index++) {
    const entry = entries[index]!;
    if (failedAssistant(entry)) continue;
    if (entry.type === "message" && entry.message.role !== "assistant") return entry.id;
    if (entry.type === "custom_message" || entry.type === "branch_summary") return entry.id;
  }
  return undefined;
}

function currentTokens(pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">, ctx: ExtensionContext, manager: ReadonlySessionManager, state: WindowState): number {
  const messages = currentWindowEntries(manager.buildContextEntries(), state).flatMap(entryToMessages);
  const usage = ctx.getContextUsage();
  if (hasValidAssistantUsage(messages) && usage?.tokens != null) return usage.tokens;
  return staticOverhead(pi, ctx) + messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function summary(windowId: string, txId: string): string {
  return `Context window checkpoint ${windowId} (${txId}). Prior transcript is available through history tools; it was not summarized.`;
}

export function prepareWindowCompaction(
  pi: Pick<ExtensionAPI, "appendEntry" | "getActiveTools" | "getAllTools">,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
): { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: WindowDetails } } {
  const manager = ctx.sessionManager;
  const state = ensureSeed(pi, manager);
  const latest = state.boundaries.at(-1);
  const threshold = (ctx.model?.contextWindow ?? Number.MAX_SAFE_INTEGER) - event.preparation.settings.reserveTokens;
  const materialize = event.reason === "threshold" && latest?.kind === "commit" &&
    !state.materializedBoundaryIds.has(latest.entryId) && currentTokens(pi, ctx, manager, state) <= threshold;

  if (materialize && latest) {
    const txId = randomUUID();
    return {
      compaction: {
        summary: summary(state.currentWindowId, txId),
        firstKeptEntryId: latest.entryId,
        tokensBefore: event.preparation.tokensBefore,
        details: {
          owner: OWNER,
          version: 1,
          kind: "materialize",
          txId,
          boundaryId: latest.entryId,
          firstWindowId: state.firstWindowId,
          previousWindowId: latest.previousWindowId,
          windowId: state.currentWindowId,
        },
      },
    };
  }

  const windowId = randomUUID();
  const txId = randomUUID();
  const reason: Exclude<WindowReason, "explicit-tool" | "tree"> = event.reason;
  const carryStartId = event.reason === "manual" ? undefined : findUnconsumedStart(currentWindowEntries(event.branchEntries, state));
  const boundaryId = appendWindowRecord(pi, manager, {
    version: 1,
    kind: "anchor",
    firstWindowId: state.firstWindowId,
    previousWindowId: state.currentWindowId,
    windowId,
    reason,
    txId,
    carryStartId,
  });
  return {
    compaction: {
      summary: summary(windowId, txId),
      firstKeptEntryId: carryStartId ?? boundaryId,
      tokensBefore: event.preparation.tokensBefore,
      details: {
        owner: OWNER,
        version: 1,
        kind: "rollover",
        txId,
        boundaryId,
        firstWindowId: state.firstWindowId,
        previousWindowId: state.currentWindowId,
        windowId,
      },
    },
  };
}

function ownedMarker(entry: SessionEntry): entry is Extract<SessionEntry, { type: "custom" }> {
  return entry.type === "custom" && entry.customType === WINDOW_ENTRY;
}

function ownedSeed(entry: SessionEntry): boolean {
  return ownedMarker(entry) && isWindowRecord(entry.data) && entry.data.kind === "seed";
}

function markerError(message: string): string {
  return `Malformed pi-codex-context state: ${message}`;
}

interface MarkerLineage {
  seedCount: number;
  firstWindowId?: string;
  currentWindowId?: string;
}

function inheritedLineage(entry: SessionEntry, lineages: Map<string, MarkerLineage>): MarkerLineage {
  if (entry.parentId === null) return { seedCount: 0 };
  const parent = lineages.get(entry.parentId);
  return parent ? { ...parent } : { seedCount: 0 };
}

function isIndexedAncestor(index: ReplayIndex, ancestorId: string, descendantId: string): boolean {
  const ancestorStart = index.entryStarts.get(ancestorId);
  const ancestorEnd = index.entryEnds.get(ancestorId);
  const descendantStart = index.entryStarts.get(descendantId);
  const descendantEnd = index.entryEnds.get(descendantId);
  return ancestorStart !== undefined && ancestorEnd !== undefined && descendantStart !== undefined && descendantEnd !== undefined &&
    ancestorStart <= descendantStart && descendantEnd <= ancestorEnd;
}

export function validateOwnedCompactions(entries: SessionEntry[]): string | undefined {
  const replayIndex = buildReplayIndex(entries, { ancestors: true });
  if (replayIndex.duplicateEntryIds.length > 0) return markerError(`duplicate entry id ${replayIndex.duplicateEntryIds[0]}`);
  for (const [index, entry] of entries.entries()) {
    if (entry.parentId === null) continue;
    const parentIndex = replayIndex.indexById.get(entry.parentId);
    if (parentIndex === undefined || parentIndex >= index) return markerError(`missing parent for ${entry.id}`);
  }

  const markers = entries.filter(ownedMarker);
  for (const entry of markers) {
    if (!isWindowRecord(entry.data)) return markerError(`invalid window marker ${entry.id}`);
  }
  const seedCount = markers.filter(ownedSeed).length;
  const windowDefinitions = new Map<string, WindowRecord>();
  for (const entry of markers) {
    if (!isWindowRecord(entry.data)) continue;
    const record = entry.data;
    if (record.kind === "seed") {
      if (windowDefinitions.has(record.windowId)) return markerError(`duplicate window ${record.windowId}`);
      windowDefinitions.set(record.windowId, record);
      continue;
    }
    if (record.kind !== "reanchor") {
      if (windowDefinitions.has(record.windowId)) return markerError(`duplicate window ${record.windowId}`);
      windowDefinitions.set(record.windowId, record);
    }
  }
  if (seedCount === 0 && markers.length > 0) return markerError("window marker has no seed");

  const lineages = new Map<string, MarkerLineage>();
  for (const [index, entry] of entries.entries()) {
    const lineage = inheritedLineage(entry, lineages);
    lineages.set(entry.id, lineage);
    if (!ownedMarker(entry)) continue;
    if (!isWindowRecord(entry.data)) continue;
    const record = entry.data;
    if (record.kind === "seed") {
      lineage.seedCount++;
      if (lineage.seedCount !== 1) return markerError(`window ${entry.id} does not have exactly one seed on its branch`);
      lineage.firstWindowId = record.firstWindowId;
      lineage.currentWindowId = record.windowId;
      continue;
    }
    if (lineage.seedCount !== 1) return markerError(`window ${entry.id} does not have exactly one seed on its branch`);
    if (record.firstWindowId !== lineage.firstWindowId) return markerError(`window chain crosses first window at ${entry.id}`);

    if (record.kind === "reanchor") {
      const definition = windowDefinitions.get(record.windowId);
      if (!definition || definition.firstWindowId !== record.firstWindowId ||
        record.previousWindowId !== (definition.kind === "seed" ? undefined : definition.previousWindowId)) {
        return markerError(`re-anchor ${entry.id} references an unknown window`);
      }
      const target = replayIndex.byId.get(record.targetId);
      if (!target) return markerError(`re-anchor ${entry.id} has an unknown target`);
      if (record.targetParentId !== null && !replayIndex.byId.has(record.targetParentId)) {
        return markerError(`re-anchor ${entry.id} has an unknown target parent`);
      }
      if (target.parentId !== record.targetParentId) return markerError(`re-anchor ${entry.id} has a mismatched target parent`);
      // Re-anchor state is historical: later rollovers may carry the same target again.
      const originEntries = entries.slice(0, index);
      const origin = windowOriginForEntry(
        originEntries,
        record.targetId,
        replayIndex.byId,
        replayIndex.indexById,
        replayIndex.entryStarts,
        replayIndex.entryEnds,
        replayIndex.windowMarkers,
      );
      if (!origin || origin.windowId !== record.windowId) return markerError(`re-anchor ${entry.id} has a mismatched target window`);
      const targetIndex = replayIndex.indexById.get(record.targetId);
      const parentIndex = record.targetParentId === null ? -1 : replayIndex.indexById.get(record.targetParentId);
      if (targetIndex === undefined || targetIndex >= index || (record.targetParentId !== null && (parentIndex === undefined || parentIndex >= index))) {
        return markerError(`re-anchor ${entry.id} has an invalid target ordering`);
      }
      if (record.carryStartId !== undefined) {
        const carryIndex = replayIndex.indexById.get(record.carryStartId);
        if (carryIndex === undefined || carryIndex >= index) return markerError(`re-anchor ${entry.id} has an invalid carry start`);
      }
      lineage.currentWindowId = record.windowId;
      continue;
    }

    if (record.kind === "anchor" && entries[index + 1]?.type !== "compaction") continue;
    if (record.previousWindowId !== lineage.currentWindowId) return markerError(`broken predecessor at ${entry.id}`);
    if (record.kind === "anchor" && record.carryStartId !== undefined) {
      const carryIndex = replayIndex.indexById.get(record.carryStartId);
      if (carryIndex === undefined || carryIndex >= index || !isIndexedAncestor(replayIndex, record.carryStartId, entry.id)) {
        return markerError(`invalid carry start at ${entry.id}`);
      }
    }
    lineage.currentWindowId = record.windowId;
  }

  for (const [index, entry] of entries.entries()) {
    if (!ownedMarker(entry) || !isWindowRecord(entry.data) || entry.data.kind !== "anchor") continue;
    const compaction = entries[index + 1];
    // Pi can abort after this append and before appendCompaction. Since the
    // context was not cut, the existing projection safely treats this anchor
    // as inert. A following compaction must still match exactly.
    if (!compaction || compaction.type !== "compaction") continue;
    if (!isWindowDetails(compaction.details) || compaction.details.kind !== "rollover" ||
      compaction.details.txId !== entry.data.txId || compaction.details.boundaryId !== entry.id ||
      compaction.details.firstWindowId !== entry.data.firstWindowId ||
      compaction.details.previousWindowId !== entry.data.previousWindowId || compaction.details.windowId !== entry.data.windowId ||
      compaction.firstKeptEntryId !== (entry.data.carryStartId ?? entry.id)) {
      return markerError(`anchor ${entry.id} has no matching compaction`);
    }
  }

  let hasManagedSeed = false;
  for (const entry of entries) {
    if (ownedSeed(entry)) {
      hasManagedSeed = true;
      continue;
    }
    if (entry.type !== "compaction" || !hasManagedSeed) continue;
    const details = entry.details;
    if (!isWindowDetails(details)) return "Another compaction provider modified this managed session";
    const boundary = replayIndex.byId.get(details.boundaryId);
    if (!boundary || !ownedMarker(boundary) || !isWindowRecord(boundary.data)) return markerError(`compaction ${entry.id} has an invalid boundary`);
    if (entry.parentId !== boundary.id) return markerError(`compaction ${entry.id} is detached from its boundary`);
    const record = boundary.data;
    if (details.firstWindowId !== record.firstWindowId || details.previousWindowId !== (record.kind === "seed" ? null : record.previousWindowId) || details.windowId !== record.windowId) {
      return markerError(`compaction ${entry.id} does not match its boundary`);
    }
    if (details.kind === "rollover") {
      if (record.kind !== "anchor" || details.txId !== record.txId || entry.firstKeptEntryId !== (record.carryStartId ?? boundary.id)) {
        return markerError(`rollover compaction ${entry.id} does not match its anchor`);
      }
    } else if (record.kind !== "commit" || entry.firstKeptEntryId !== boundary.id) {
      return markerError(`materialization ${entry.id} does not match its commit`);
    }
  }

  const firstManagedSeed = entries.findIndex(ownedSeed);
  if (firstManagedSeed >= 0) {
    for (const entry of entries.slice(firstManagedSeed + 1)) {
      if (entry.type !== "custom" || entry.customType !== RESET_ENTRY || !isResetPrepare(entry.data)) {
        if (entry.type === "custom" && entry.customType === RESET_ENTRY) return markerError(`invalid reset prepare ${entry.id}`);
        continue;
      }
      const prepare = entry.data;
      const assistant = replayIndex.byId.get(prepare.assistantEntryId);
      if (assistant?.type !== "message" || assistant.message.role !== "assistant" ||
        !assistant.message.content.some((part) => part.type === "toolCall" && part.id === prepare.toolCallId && part.name === "new_context")) {
        return markerError(`reset prepare ${entry.id} has no matching tool call`);
      }
    }
  }
  return undefined;
}
