/** Primary-turn transcript formatting for advisor reviews. */

import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

// ---- transcript delta formatting (primary turn → markdown for the advisor) ----

// No truncation of the delta. The advisor is a peer reviewer (its own model, its
// own read/grep/find), not a cheap/lightweight pass — nothing in the design says
// otherwise. It must see what the main model saw, verbatim; clipping fields just
// hid the part it needed to verify and bred false "didn't persist"/"garbled"
// advice. (The advisor CAN re-read to verify — system prompt — but that's about
// its actions, not a license to starve its input.)
//
// Input-budget policy (advisor self-compaction): the advisor's context is a pure
// linear accumulation of INDEPENDENT turn deltas — no essential cross-turn state
// lives in the agent's message history (pending advice lives in the shared queue
// and rides the reconfirm preamble, not the transcript). So when the advisor's own context
// approaches the window it self-compacts: #drain clears ONLY the agent's message
// history (#softReset) and replays the current batch into a fresh context. Two
// triggers — PROACTIVE (before prompting, when usage crosses COMPACT_AT_PERCENT)
// and REACTIVE (a review that still comes back stopReason=="length"). The reactive
// path is loop-safe: if the agent was ALREADY fresh and still overflowed, the
// single batch genuinely doesn't fit, so we stop self-compacting and fall through
// to the normal failed-review handling instead of spinning. This replaces the old
// behavior (overflow -> fail review -> retry 3x into the same wall -> give up,
// possibly shipping a stale held note on a terminal turn). Note AdvisorRuntime.reset
// is still separately triggered by the PRIMARY's compaction / history rewrites;
// self-compaction is the advisor managing its OWN budget between those resets.
function textOf(content: Array<{ type: string; text?: string }>): string {
	return content.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text as string).join("");
}

// Render any tool-call argument value as readable text with REAL newlines preserved
// at EVERY depth. We never JSON.stringify content: that escapes every real newline
// into a literal backslash-n (so a heredoc body reaches the advisor as `<<'EOF'\n...`
// — the exact bug that produced a bogus "garbled markdown" advisory), and escaping
// only at the top level merely pushes the bug into nested strings (e.g. edits[].oldText).
// String leaves ride verbatim; containers are walked. Tool args are plain JSON data
// from the model, so there are no cycles or non-serializable leaves to guard against;
// a depth cap is the only (never-hit-in-practice) backstop.
function renderArgValue(v: unknown, indent: string, depth: number): string {
	// Multiline strings ride raw on following lines — NOT re-indented, which would
	// alter the very content (e.g. a heredoc body) the advisor must see verbatim.
	if (typeof v === "string") return v.includes("\n") ? `\n${v}` : ` ${v}`;
	if (v === null || typeof v !== "object") return ` ${String(v)}`;
	if (depth >= 8) return " […]";
	const childIndent = `${indent}  `;
	if (Array.isArray(v)) {
		if (v.length === 0) return " []";
		return v.map((e, i) => `\n${indent}- [${i}]${renderArgValue(e, childIndent, depth + 1)}`).join("");
	}
	const entries = Object.entries(v as Record<string, unknown>);
	if (entries.length === 0) return " {}";
	return entries.map(([k, val]) => `\n${indent}${k}:${renderArgValue(val, childIndent, depth + 1)}`).join("");
}

function renderToolArgs(args: Record<string, unknown> | undefined): string {
	if (!args || typeof args !== "object") return "";
	const entries = Object.entries(args);
	if (entries.length === 0) return "";
	return entries.map(([k, v]) => `${k}:${renderArgValue(v, "  ", 0)}`).join("\n");
}

// Format one primary turn (optionally preceded by the user prompt) as a markdown
// string with REAL newlines throughout (renderToolArgs keeps arg content verbatim).
// The sections are joined with explicit "\n\n" here so the boundary never depends on
// how a provider concatenates content parts — see buildReviewMessages.
export function formatTurnDelta(opts: {
	userPrompt?: string;
	assistant?: AssistantMessage;
	toolResults?: ToolResultMessage[];
}): string {
	const parts: string[] = [];
	if (opts.userPrompt?.trim()) parts.push(`#### User\n\n${opts.userPrompt.trim()}`);

	// Correlate calls → results by toolCallId so an edit's raw args can be suppressed
	// in favor of the result's diff — but ONLY when a SUCCESSFUL diff exists. A failed
	// edit (no diff, or an error result whose diff is untrustworthy) keeps its attempted
	// {oldText,newText} so the advisor can still diagnose the failure. Name-agnostic:
	// any non-error call whose result carries a diff.
	const diffByCallId = new Map<string, string>();
	for (const tr of opts.toolResults ?? []) {
		const id = (tr as { toolCallId?: string }).toolCallId;
		const d = (tr as { details?: { diff?: unknown } }).details?.diff;
		if (id && !tr.isError && typeof d === "string" && d.trim()) diffByCallId.set(id, d);
	}

	const a = opts.assistant;
	if (a) {
		const sub: string[] = [];
		for (const c of a.content) {
			if (c.type === "thinking" && c.thinking?.trim()) {
				sub.push(`<thinking>\n${c.thinking.trim()}\n</thinking>`);
			} else if (c.type === "text" && c.text?.trim()) {
				sub.push(c.text.trim());
			} else if (c.type === "toolCall") {
				// When this call produced a diff (a successful edit), suppress the raw
				// {oldText,newText} args and let the result's -/+ diff carry the change: the
				// args are two unannotated peer blobs and the advisor — reviewing AFTER the
				// edit landed (a fresh read shows the NEW side) — can't tell which is on disk
				// ("didn't persist"). With NO diff (failed edit, non-edit tool) show the args
				// verbatim; for a failed edit they're the only evidence of what was attempted.
				const edits = (c.arguments as { edits?: unknown[] } | undefined)?.edits;
				const hasDiff = diffByCallId.has((c as { id?: string }).id ?? "");
				if (hasDiff) {
					const p = (c.arguments as { path?: string }).path ?? "?";
					const blocks = Array.isArray(edits) ? ` — ${edits.length} block(s)` : "";
					sub.push(`→ tool \`${c.name}\`(${p})${blocks}; diff in tool result`);
				} else {
					const argsText = renderToolArgs(c.arguments as Record<string, unknown> | undefined);
					sub.push(argsText ? `→ tool \`${c.name}\`:\n${argsText}` : `→ tool \`${c.name}\``);
				}
			}
		}
		if (sub.length) parts.push(`#### Assistant\n\n${sub.join("\n\n")}`);
	}

	for (const tr of opts.toolResults ?? []) {
		// Prefer the canonical line-numbered unified diff (the same view the human /
		// main model gets, computed by pi's edit-diff) for a SUCCESSFUL result: its -/+
		// markers unambiguously frame removed-vs-current lines, which the flat
		// {oldText,newText} echo lacks. It is also a pinned point-in-time snapshot of
		// THIS turn's change — the advisor's own read returns current (possibly later-
		// edited) disk, so the inline diff is not re-derivable and must ride verbatim.
		// On an ERROR, show the text body instead: the error is the diagnostic, and a
		// diff from a failed edit is untrustworthy (did it apply? partially?).
		const diff = (tr as { details?: { diff?: unknown } }).details?.diff;
		const body =
			!tr.isError && typeof diff === "string" && diff.trim()
				? diff
				: textOf(tr.content as Array<{ type: string; text?: string }>);
		parts.push(`#### Tool result: \`${tr.toolName}\`${tr.isError ? " (error)" : ""}\n\n${body || "(no text output)"}`);
	}
	return parts.join("\n\n");
}

// Assemble a review prompt as a BATCH of user messages: a header/reconfirm turn,
// then one user turn per primary-turn delta. Each message carries exactly ONE text
// block whose internal section separators ("\n\n") are explicit, so nothing depends
// on how a provider joins multiple content parts within a message. Between turns:
// OpenAI-family endpoints (OpenRouter, the default) keep them as distinct turns;
// Anthropic-family folds consecutive user turns into one (\n-joined, per the Messages
// API). Each turn starts with a #### / ### header, so it stays legible either way,
// and arg content rides verbatim (real newlines, no \n-escaping) — the whole point.
export function buildReviewMessages(preamble: string, batch: string[]): UserMessage[] {
	const now = Date.now();
	const messages: UserMessage[] = [
		{ role: "user", content: [{ type: "text", text: `### Session update\n\n${preamble}`.trimEnd() }], timestamp: now },
	];
	for (const delta of batch) {
		if (delta.trim()) messages.push({ role: "user", content: [{ type: "text", text: delta }], timestamp: now });
	}
	return messages;
}
