import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { calculateContextTokens, estimateTokens, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { registerTools } from "./tools.js";
import {
  deriveWindowState,
  REMINDER_ENTRY,
  type WindowState,
} from "./store.js";
import {
  commitExplicitWindow,
  ensureSeed,
  hasValidAssistantUsage,
  poison,
  poisonReason,
  prepareExplicitReset,
  prepareWindowCompaction,
  projectedMessages,
  recoverExplicitReset,
  reanchorTree,
  staticOverhead,
  validateOwnedCompactions,
} from "./window-driver.js";

const pendingResets = new WeakMap<object, string>();
const pendingTreeTargets = new WeakMap<object, string>();

function fatalMessage(reason: string): AgentMessage {
  return {
    role: "custom",
    customType: "pi-codex-context-error",
    display: false,
    timestamp: 0,
    content: `<context_window_error>Context management stopped safely: ${reason}. Report this error instead of continuing the task.</context_window_error>`,
  };
}

function reminderActive(entries: SessionEntry[], windowId: string): boolean {
  return entries.some(
    (entry) => entry.type === "custom" && entry.customType === REMINDER_ENTRY &&
      typeof entry.data === "object" && entry.data !== null &&
      (entry.data as Record<string, unknown>).windowId === windowId,
  );
}

function metadata(state: WindowState, reminder: boolean): AgentMessage {
  const warning = reminder
    ? "\n<context_window_reminder>The context window is nearing its limit. Record durable state with notes_write_file or notes_append_file, then call new_context as the only tool call. Do not mention this reminder to the user.</context_window_reminder>"
    : "";
  return {
    role: "custom",
    customType: "pi-codex-context-metadata",
    display: false,
    timestamp: 0,
    content: `<context_window>\n  <first_window_id>${state.firstWindowId}</first_window_id>\n  <previous_window_id>${state.previousWindowId ?? ""}</previous_window_id>\n  <current_window_id>${state.currentWindowId}</current_window_id>\n</context_window>\n<context_window_guidance>Use notes tools for durable task state and history tools to recover exact prior messages or tool results. Start a fresh window with new_context when needed; call it alone. Do not discuss context-window mechanics unless asked.</context_window_guidance>${warning}`,
  };
}

function messageKey(message: AgentMessage): string {
  if (message.role !== "custom") return "";
  return JSON.stringify([message.customType, message.content]);
}

function keepSyntheticCustomMessages(incoming: AgentMessage[], stored: AgentMessage[]): AgentMessage[] {
  const counts = new Map<string, number>();
  for (const message of stored) {
    const key = messageKey(message);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return incoming.filter((message) => {
    const key = messageKey(message);
    if (!key) return false;
    const count = counts.get(key) ?? 0;
    if (count === 0) return true;
    counts.set(key, count - 1);
    return false;
  });
}

function currentState(ctx: ExtensionContext): WindowState {
  const reason = poisonReason(ctx.sessionManager);
  if (reason) throw new Error(reason);
  const state = deriveWindowState(ctx.sessionManager.getBranch());
  if (!state) throw new Error("Context window state is unavailable");
  return state;
}

export default function codexContext(pi: ExtensionAPI): void {
  registerTools(pi, {
    getRemaining(ctx) {
      const state = currentState(ctx);
      const messages = projectedMessages(ctx.sessionManager, state);
      const usage = ctx.getContextUsage();
      const estimated = hasValidAssistantUsage(messages) && usage?.tokens != null
        ? usage.tokens
        : staticOverhead(pi, ctx) + messages.reduce((total, message) => total + estimateTokens(message), 0);
      const contextWindow = ctx.model?.contextWindow ?? usage?.contextWindow ?? 0;
      return { tokens_left: Math.max(0, contextWindow - estimated), context_window: contextWindow };
    },
    requestReset(toolCallId, ctx) {
      const reason = poisonReason(ctx.sessionManager);
      if (reason) throw new Error(reason);
      const latest = [...ctx.sessionManager.getBranch()].reverse().find(
        (entry) => entry.type === "message" && entry.message.role === "assistant",
      );
      if (latest?.type !== "message" || latest.message.role !== "assistant") throw new Error("new_context must be called by an assistant response");
      const calls = latest.message.content.filter((part) => part.type === "toolCall");
      if (calls.length !== 1 || calls[0]!.id !== toolCallId || calls[0]!.name !== "new_context") {
        throw new Error("new_context must be the only tool call in the assistant response");
      }
      prepareExplicitReset(pi, ctx.sessionManager, toolCallId);
      pendingResets.set(ctx.sessionManager, toolCallId);
    },
  });

  pi.on("session_before_tree", async (event, ctx) => {
    pendingTreeTargets.set(ctx.sessionManager, event.preparation.targetId);
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const violation = validateOwnedCompactions(ctx.sessionManager.getEntries());
      if (violation) throw new Error(violation);
      ensureSeed(pi, ctx.sessionManager);
      recoverExplicitReset(pi, ctx.sessionManager);
      const recoveredViolation = validateOwnedCompactions(ctx.sessionManager.getEntries());
      if (recoveredViolation) throw new Error(recoveredViolation);
      currentState(ctx);
    } catch (error) {
      poison(ctx.sessionManager, error);
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    pendingResets.delete(ctx.sessionManager);
    const targetId = pendingTreeTargets.get(ctx.sessionManager);
    pendingTreeTargets.delete(ctx.sessionManager);
    try {
      const violation = validateOwnedCompactions(ctx.sessionManager.getEntries());
      if (violation) throw new Error(violation);
      if (targetId) reanchorTree(pi, ctx.sessionManager, targetId);
      else ensureSeed(pi, ctx.sessionManager);
      recoverExplicitReset(pi, ctx.sessionManager);
      const reanchoredViolation = validateOwnedCompactions(ctx.sessionManager.getEntries());
      if (reanchoredViolation) throw new Error(reanchoredViolation);
      currentState(ctx);
    } catch (error) {
      poison(ctx.sessionManager, error);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const reason = poisonReason(ctx.sessionManager);
    if (reason) return { block: true, reason: `Context management is unavailable: ${reason}`, terminate: true };
    if (event.toolName !== "new_context") return;
    const latest = [...ctx.sessionManager.getBranch()].reverse().find(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    );
    const count = latest?.type === "message" && latest.message.role === "assistant"
      ? latest.message.content.filter((part) => part.type === "toolCall").length
      : 0;
    if (count !== 1) return { block: true, reason: "new_context must be the only tool call in the assistant response" };
  });

  pi.on("turn_end", async (event, ctx) => {
    const pending = pendingResets.get(ctx.sessionManager);
    let committed = false;
    if (pending) {
      pendingResets.delete(ctx.sessionManager);
      const toolResult = event.toolResults.find((item) => item.toolCallId === pending);
      if (toolResult && !toolResult.isError) {
        try {
          commitExplicitWindow(pi, ctx.sessionManager);
          committed = true;
        } catch (error) {
          poison(ctx.sessionManager, error);
        }
      }
    }
    if (committed || poisonReason(ctx.sessionManager) || event.message.role !== "assistant") return;
    const contextWindow = ctx.model?.contextWindow;
    if (!contextWindow || !event.message.usage) return;
    const remaining = contextWindow - calculateContextTokens(event.message.usage);
    if (remaining > Math.max(32_000, Math.floor(contextWindow * 0.1))) return;
    const state = deriveWindowState(ctx.sessionManager.getBranch());
    if (!state || reminderActive(ctx.sessionManager.getBranch(), state.currentWindowId)) return;
    try {
      pi.appendEntry(REMINDER_ENTRY, { version: 1, windowId: state.currentWindowId });
    } catch (error) {
      poison(ctx.sessionManager, error);
    }
  });

  pi.on("context", async (event, ctx) => {
    const reason = poisonReason(ctx.sessionManager);
    if (reason) return { messages: [fatalMessage(reason)] };
    try {
      const state = currentState(ctx);
      const stored = state.boundaries.length === 0 ? event.messages : projectedMessages(ctx.sessionManager, state);
      const extras = state.boundaries.length === 0 ? [] : keepSyntheticCustomMessages(event.messages, stored);
      const reminder = reminderActive(ctx.sessionManager.getBranch(), state.currentWindowId);
      return { messages: [metadata(state, reminder), ...extras, ...stored] };
    } catch (error) {
      poison(ctx.sessionManager, error);
      return { messages: [fatalMessage(poisonReason(ctx.sessionManager)!)] };
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const reason = poisonReason(ctx.sessionManager);
    if (reason) return { cancel: true };
    try {
      return prepareWindowCompaction(pi, event, ctx);
    } catch (error) {
      poison(ctx.sessionManager, error);
      return { cancel: true };
    }
  });

  pi.on("session_compact_failed", async (_event, ctx) => {
    try {
      const violation = validateOwnedCompactions(ctx.sessionManager.getEntries());
      if (violation) throw new Error(violation);
    } catch (error) {
      poison(ctx.sessionManager, error);
    }
  });

  pi.on("session_compact", async (event, ctx) => {
    try {
      const violation = validateOwnedCompactions(ctx.sessionManager.getEntries());
      if (violation) throw new Error(violation);
      const details = event.compactionEntry.details;
      if (!details || typeof details !== "object" || (details as Record<string, unknown>).owner !== "pi-codex-context") {
        throw new Error("Unexpected compaction result");
      }
      currentState(ctx);
    } catch (error) {
      poison(ctx.sessionManager, error);
    }
  });

}
