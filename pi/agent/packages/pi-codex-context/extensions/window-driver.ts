import { randomUUID } from "node:crypto";
import { estimateTokens, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  currentWindowEntries,
  deriveWindowState,
  entryToMessages,
  isWindowDetails,
  isWindowRecord,
  OWNER,
  WINDOW_ENTRY,
  type ReadonlySessionManager,
  type WindowDetails,
  type WindowReason,
  type WindowRecord,
  type WindowState,
} from "./store.js";

const ERROR = Symbol.for("pi-codex-context.error");
const DEFAULT_STATIC_OVERHEAD = 12_000;

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

function currentTokens(ctx: ExtensionContext, manager: ReadonlySessionManager, state: WindowState): number {
  const entries = currentWindowEntries(manager.buildContextEntries(), state);
  const hasCurrentAssistant = entries.some(
    (entry) => entry.type === "message" && entry.message.role === "assistant" && !failedAssistant(entry),
  );
  const usage = ctx.getContextUsage();
  if (hasCurrentAssistant && usage?.tokens != null) return usage.tokens;
  return DEFAULT_STATIC_OVERHEAD + entries.flatMap(entryToMessages).reduce((total, message) => total + estimateTokens(message), 0);
}

function summary(windowId: string, txId: string): string {
  return `Context window checkpoint ${windowId} (${txId}). Prior transcript is available through history tools; it was not summarized.`;
}

export function prepareWindowCompaction(
  pi: Pick<ExtensionAPI, "appendEntry">,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
): { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: WindowDetails } } {
  const manager = ctx.sessionManager;
  const state = ensureSeed(pi, manager);
  const latest = state.boundaries.at(-1);
  const threshold = (ctx.model?.contextWindow ?? Number.MAX_SAFE_INTEGER) - event.preparation.settings.reserveTokens;
  const materialize = event.reason === "threshold" && latest?.kind === "commit" &&
    !state.materializedBoundaryIds.has(latest.entryId) && currentTokens(ctx, manager, state) <= threshold;

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
  const reason = event.reason as WindowReason;
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

export function validateOwnedCompactions(entries: SessionEntry[]): string | undefined {
  const seedIndex = entries.findIndex(
    (entry) => entry.type === "custom" && entry.customType === WINDOW_ENTRY && isWindowRecord(entry.data) && entry.data.kind === "seed",
  );
  if (seedIndex < 0) return undefined;
  for (const entry of entries.slice(seedIndex + 1)) {
    if (entry.type === "compaction" && !isWindowDetails(entry.details)) return "Another compaction provider modified this managed session";
  }
  return undefined;
}
