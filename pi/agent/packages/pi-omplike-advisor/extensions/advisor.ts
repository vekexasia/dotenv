/**
 * /advisor — a persistent second model that reviews the main agent's work each
 * turn and injects concise advice inline. Port of oh-my-pi's advisor onto
 * upstream pi's extension API.
 *
 * Enable with `/advisor on` (persisted in the current Pi session). New sessions
 * start disabled. The advisor model defaults to the `advisor` entry in modes.json.
 *
 * Delivery model. Every advise() call enters one shared queue; only primary turn
 * boundaries or advisor-review completion flush it. Nothing is a hard interrupt:
 * upstream pi's extension surface delivers via `steer` (the message folds in at
 * the agent's next-step boundary; `triggerTurn` additionally wakes an idle agent). We never call
 * `abort()`. So:
 *
 *   nit      → tagged as raised about an earlier step. If observed while an
 *              assistant turn is running, delivery waits for turn_end because
 *              Pi would not insert its steer before then anyway: non-terminal
 *              turns flush it before the next step, while terminal turns route
 *              it through final-review reconfirmation. Thus obsolete lagging
 *              nits are dropped and survivors delivered after a final answer
 *              carry the self-contained-restatement directive. Deferral can
 *              place intervening user/extension steers before the advisory;
 *              correctness of terminal classification takes precedence over
 *              preserving callback-time queue order.
 *              The terminal best-effort path ships only concerns/blockers (an
 *              unconfirmed nit is what holding was meant to keep away).
 *   concern  → ALWAYS held, never steered on first emission.
 *   blocker  → ALWAYS held, never steered on first emission.
 *
 * Why always-hold for high severity: the advisor reviews turn N asynchronously
 * (seconds), so by the time any advice could land the primary has almost always
 * done follow-up work — the advice is stale. Instead we hold it and let the next
 * review reconfirm it (held notes ride a reconfirm preamble; the advisor re-
 * raises survivors, stays silent on the resolved ones).
 *
 * Catch-up block: while a high-severity note is held — or whenever a turn is
 * about to idle — we stall the primary's next step (by awaiting in the `turn_end`
 * hook, which the agent loop awaits) so the advisor can catch up. The wait backs
 * off 15s→30s→60s… capped at 120s, is Escape-abortable, and shows a notice. Once
 * the advisor settles, surviving held notes are steered in against the now-unraced
 * state. This is a deliberate throttle (omp's syncBacklog idea).
 *
 * An optional WATCHDOG.md in the cwd is appended to the advisor's system prompt
 * (advisor-only guidance: review priorities, project traps).
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Agent, type AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { convertToLlm, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, getKeybindings, Input, SelectList, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { loadModeSpec } from "./lib/mode-utils.js";
// ===========================================================================
// Advisor core — persistent second model that watches the main agent.
//
// Port of oh-my-pi's advisor onto upstream pi's public extension surface. The
// advisor is a long-lived `Agent` with its own model + read-only tools
// (read/grep/find) and one `advise` tool. It is fed the primary transcript one
// turn-delta at a time and may inject concise advice back. It is NOT an
// executor: it cannot edit, run commands, or change session state.
// ===========================================================================

export type AdvisorSeverity = "nit" | "concern" | "blocker";
export interface AdvisorNote {
	note: string;
	severity?: AdvisorSeverity;
}

// ---- advise tool (agent-core tool; lives only on the advisor agent) ----

const adviseSchema = Type.Object({
	note: Type.String({
		description: "One concrete piece of advice for the agent you are watching. Terse, specific, actionable.",
	}),
	severity: Type.Optional(
		Type.Union([Type.Literal("nit"), Type.Literal("concern"), Type.Literal("blocker")], {
			description: "How strongly to weigh this. Omit for a plain nit.",
		}),
	),
});

const SEVERITY_RANK: Record<AdvisorSeverity, number> = { nit: 1, concern: 2, blocker: 3 };
const rankOf = (s: AdvisorSeverity | undefined): number => SEVERITY_RANK[s ?? "nit"];
const dedupeKey = (note: string): string => note.trim().replace(/\s+/g, " ");
/** High severity (concern/blocker) is always held + reconfirmed; nits deliver now. */
export const isHighSeverity = (s: AdvisorSeverity | undefined): boolean => s === "concern" || s === "blocker";

/** Catch-up block backoff: base, 2×, 4×… capped. consecutive=0 → base (15s default). */
export function nextBackoffMs(consecutive: number, baseMs = 15_000, capMs = 120_000): number {
	return Math.min(capMs, baseMs * 2 ** Math.max(0, consecutive));
}

/**
 * A turn is terminal (the agent is about to go idle) when its assistant message
 * issued no tool calls — the agent-loop's inner loop exits unless something is
 * steered in. We block-until-settled on terminal turns so a blocker the advisor
 * raises about the final turn is caught before control returns to the user.
 *
 * Approximation: a turn WITH tool calls can still end the run if a tool returns
 * `terminate` or a stop hook fires; we'd classify that non-terminal. The cost is
 * only a *delay*, not a loss — a held note still rides the next turn's catch-up
 * block; the sole gap is a brand-new blocker raised about such a turn (nothing
 * previously held), which then lands on the next user turn instead of before idle.
 */
export function isTerminalTurn(message: { content?: ReadonlyArray<{ type: string }> } | undefined): boolean {
	return !(message?.content ?? []).some((c) => c.type === "toolCall");
}

/** Structural slice of AdvisorRuntime the catch-up block needs (so it's testable). */
export interface TurnBlockRuntime {
	readonly hasHighPriority: boolean;
	takeAllAdvice(): AdvisorNote[];
	requeueAdvice(note: string, severity?: AdvisorSeverity): void;
	waitUntilSettled(timeoutMs: number, signal?: AbortSignal): Promise<"settled" | "timeout" | "aborted" | "failed">;
}

/**
 * The catch-up block, run once per primary `turn_end` (after the delta is pushed).
 * Returns the next `consecutiveBlocks` count for the caller to carry.
 *
 * - Non-terminal turn with nothing held → no block (streak resets to 0).
 * - Otherwise block, racing advisor-settled vs a timeout vs the abort signal:
 *     - terminal → timeout = cap (block until the advisor finishes the last turn).
 *     - mid-run  → timeout = backoff(consecutiveBlocks); on timeout, keep the held
 *                  notes and lengthen the next wait (return consecutiveBlocks+1).
 * - On settle: steer in whatever survived reconfirmation (may be empty), reset streak.
 * - On timeout / failed reconfirm (advisor errored out): non-terminal keeps the
 *   queued advice and lengthens the next wait; terminal delivers concerns/blockers
 *   best-effort (it's the last chance before control returns to the user, and
 *   the stakes justify an unconfirmed delivery) but requeues NITS without marking
 *   them reconfirmed. A successful late review can then prune or confirm them;
 *   after failure, the next primary boundary applies normal nit policy.
 * - On abort (user hit Escape): bail, keep held notes + streak.
 */
export async function runTurnBlock(opts: {
	terminal: boolean;
	runtime: TurnBlockRuntime;
	consecutiveBlocks: number;
	baseMs?: number;
	capMs?: number;
	signal?: AbortSignal;
	notify: (msg: string) => void;
	deliverHeld: (notes: AdvisorNote[], opts?: { terminal?: boolean }) => void;
}): Promise<number> {
	const { terminal, runtime } = opts;
	const baseMs = opts.baseMs ?? 15_000;
	const capMs = opts.capMs ?? 120_000;
	if (!terminal && !runtime.hasHighPriority) return 0;

	const timeoutMs = terminal ? capMs : nextBackoffMs(opts.consecutiveBlocks, baseMs, capMs);
	opts.notify(
		terminal
			? "advisor: catching up before the turn ends…"
			: `advisor: waiting up to ${Math.round(timeoutMs / 1000)}s to catch up…`,
	);

	const result = await runtime.waitUntilSettled(timeoutMs, opts.signal);
	if (result === "aborted") return opts.consecutiveBlocks; // user bailed; keep held + streak
	if (result === "settled") {
		// Only a successful reconfirmation settles; the advisor has pruned recanted
		// entries, so the shared queue is the confirmed survivor set.
		const held = runtime.takeAllAdvice();
		if (held.length) opts.deliverHeld(held, { terminal });
		return 0;
	}
	// timeout OR failed (advisor errored 3x and dropped the reconfirm). Either way
	// the held notes are NOT confirmed.
	if (terminal) {
		// Best-effort only for concerns/blockers. Requeue nits WITHOUT marking a
		// reconfirmation; a late successful review may still prune them.
		const held = runtime.takeAllAdvice();
		const high = held.filter((n) => isHighSeverity(n.severity));
		for (const n of held) if (!isHighSeverity(n.severity)) runtime.requeueAdvice(n.note, n.severity);
		if (high.length) {
			opts.deliverHeld(high, { terminal: true });
			opts.notify("advisor didn't reconfirm in time; delivering held advice anyway");
		}
		return 0;
	}
	return opts.consecutiveBlocks + 1; // mid-run: keep held unconfirmed, lengthen next wait
}

/**
 * Render held advisories as a reconfirm preamble prepended to the next review.
 * Empty string when nothing is held.
 */
export function formatReconfirmPreamble(held: readonly AdvisorNote[]): string {
	if (!held.length) return "";
	const items = held.map((n) => `- [${(n.severity ?? "nit").toUpperCase()}] ${n.note}`).join("\n");
	return [
		"### Held advisories — reconfirm",
		"",
		"You raised these on an earlier step; they were held pending reconfirmation, because by now the agent may have already addressed them. Re-check each against the latest activity below.",
		"For every item that STILL applies, call `advise` again — same severity, or higher if it's gotten worse; never lower it. Say nothing for the rest — silence drops them. Do NOT call `advise` to announce that an item is resolved or that all are cleared; just stay silent.",
		"",
		items,
		"",
		"---",
		"",
	].join("\n");
}

/** Parse the hidden `/advisor test <nit|concern|blocker> <note>` test hook args. */
export function parseAdvisorTestArgs(args: string): { severity: AdvisorSeverity; note: string } | null {
	const m = args.trim().match(/^test\s+(nit|concern|blocker)\s+([\s\S]+)$/i);
	if (!m) return null;
	return { severity: m[1].toLowerCase() as AdvisorSeverity, note: m[2].trim() };
}

export type AdvisorThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const ADVISOR_THINKING_LEVELS: AdvisorThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface AdvisorModelSearchItem {
	provider: string;
	id: string;
	name?: string;
}

export function filterAdvisorModels<T extends AdvisorModelSearchItem>(models: readonly T[], query: string): T[] {
	return fuzzyFilter([...models], query, (model) => `${model.provider}/${model.id} ${model.name ?? ""}`);
}

interface AdvisorModelPickerItem extends AdvisorModelSearchItem {
	label: string;
}

const ADVISOR_MODEL_PICKER_MAX_ROWS = 8;

class AdvisorModelPicker extends Container {
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly items: readonly AdvisorModelPickerItem[];
	private readonly done: (value: string | undefined) => void;
	private list!: SelectList;
	private closed = false;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(items: readonly AdvisorModelPickerItem[], tui: TUI, theme: Theme, done: (value: string | undefined) => void) {
		super();
		this.items = items;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.addChild(new Text(theme.fg("accent", "Advisor model"), 1, 0));
		this.addChild(this.searchInput);
		this.addChild(this.listContainer);
		this.addChild(new Text(theme.fg("dim", "up/down move | Enter select | Esc cancel"), 1, 0));
		this.searchInput.onSubmit = () => this.finish(this.list.getSelectedItem()?.value);
		this.searchInput.onEscape = () => this.finish(undefined);
		this.refreshList();
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down")) {
			this.list.handleInput(data);
			this.tui.requestRender();
			return;
		}
		const previousValue = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		if (this.searchInput.getValue() !== previousValue) this.refreshList();
	}

	private refreshList(): void {
		const filtered = filterAdvisorModels(this.items, this.searchInput.getValue());
		const listItems = filtered.map((item) => ({
			value: item.label,
			label: item.label,
			...(item.name ? { description: item.name } : {}),
		}));
		this.list = new SelectList(listItems, Math.min(ADVISOR_MODEL_PICKER_MAX_ROWS, Math.max(1, listItems.length)), {
			selectedPrefix: (text) => this.theme.fg("accent", text),
			selectedText: (text) => this.theme.fg("accent", text),
			description: (text) => this.theme.fg("muted", text),
			scrollInfo: (text) => this.theme.fg("dim", text),
			noMatch: (text) => this.theme.fg("warning", text),
		});
		this.listContainer.clear();
		this.listContainer.addChild(this.list);
		this.tui.requestRender();
	}

	private finish(value: string | undefined): void {
		if (this.closed) return;
		this.closed = true;
		this.done(value);
	}
}

export interface AdvisorModelOverride {
	provider: string;
	modelId: string;
}

export interface AdvisorSessionState {
	enabled: boolean;
	model?: AdvisorModelOverride;
	thinkingLevel?: AdvisorThinkingLevel;
}

export const ADVISOR_STATE_TYPE = "pi-omplike-advisor-state";

function copyAdvisorSessionState(state: AdvisorSessionState): AdvisorSessionState {
	return {
		enabled: state.enabled,
		...(state.model ? { model: { ...state.model } } : {}),
		...(state.thinkingLevel ? { thinkingLevel: state.thinkingLevel } : {}),
	};
}

type WorkflowAdvisorState = {
	sessions: Map<string, AdvisorSessionState>;
	runs: Map<string, { sessionId: string; state: AdvisorSessionState }>;
};
const WORKFLOW_ADVISOR_STATE_KEY = Symbol.for("pi-omplike-advisor.workflow-state");
const workflowAdvisorState = ((globalThis as any)[WORKFLOW_ADVISOR_STATE_KEY] ??= { sessions: new Map(), runs: new Map() }) as WorkflowAdvisorState;
const workflowSessionStates = workflowAdvisorState.sessions;
const workflowRunStates = workflowAdvisorState.runs;

/** Parse `/advisor model provider/model [thinking]`; no args opens the picker. */
export function parseAdvisorModelArgs(args: string): { model: AdvisorModelOverride; thinkingLevel?: AdvisorThinkingLevel } | null {
	const fields = args.trim().split(/\s+/);
	if (fields.length < 2 || fields.length > 3 || fields[0].toLowerCase() !== "model") return null;
	const slash = fields[1].indexOf("/");
	if (slash <= 0 || slash === fields[1].length - 1) return null;
	const thinkingLevel = fields[2]?.toLowerCase() as AdvisorThinkingLevel | undefined;
	if (thinkingLevel && !ADVISOR_THINKING_LEVELS.includes(thinkingLevel)) return null;
	return { model: { provider: fields[1].slice(0, slash), modelId: fields[1].slice(slash + 1) }, ...(thinkingLevel ? { thinkingLevel } : {}) };
}

function normalizeAdvisorSessionState(data: unknown, previous: AdvisorSessionState): AdvisorSessionState {
	if (!data || typeof data !== "object") return previous;
	const value = data as Record<string, unknown>;
	const next: AdvisorSessionState = { ...previous };
	if (typeof value.enabled === "boolean") next.enabled = value.enabled;
	if (value.model && typeof value.model === "object") {
		const model = value.model as Record<string, unknown>;
		if (typeof model.provider === "string" && typeof model.modelId === "string") next.model = { provider: model.provider, modelId: model.modelId };
	} else if (value.model === null) {
		delete next.model;
	}
	if (typeof value.thinkingLevel === "string" && ADVISOR_THINKING_LEVELS.includes(value.thinkingLevel as AdvisorThinkingLevel))
		next.thinkingLevel = value.thinkingLevel as AdvisorThinkingLevel;
	else if (value.thinkingLevel === null) delete next.thinkingLevel;
	return next;
}

/** Reconstruct the latest advisor state on the active session branch. */
export function readAdvisorSessionState(entries: readonly any[], fallback: AdvisorSessionState = { enabled: false }): AdvisorSessionState {
	let state = copyAdvisorSessionState(fallback);
	for (const entry of entries) {
		if (entry?.type === "custom" && entry.customType === ADVISOR_STATE_TYPE) state = normalizeAdvisorSessionState(entry.data, state);
	}
	return state;
}

export function advisorRuntimeChangePolicy(runtimeBusy: boolean, configMatches: boolean): "reuse" | "defer" | "rebuild" {
	if (configMatches) return "reuse";
	return runtimeBusy ? "defer" : "rebuild";
}
/**
 * The advise tool. Dedupes by normalized note text + severity rank: a repeat at
 * the same-or-lower severity is dropped, a real escalation (nit→concern→blocker)
 * passes through. Dedup is recorded only when the note is actually *delivered*
 * (`onAdvice` returns true). Queued or dropped advice returns false and stays
 * unrecorded until its actual boundary delivery.
 */
export class AdviseTool {
	readonly name = "advise";
	readonly label = "Advise";
	readonly description =
		"Send one concrete, ACTIONABLE piece of advice to the agent you are watching. Use sparingly; stay silent when nothing matters. Call it to head off likely-wrong or materially wasteful work. NEVER call it to report status, acknowledge, confirm, summarize, or signal that all is well / resolved / nothing-further-needed — in those cases emit nothing.";
	readonly parameters = adviseSchema as any;
	#delivered = new Map<string, number>();

	// onAdvice returns true if delivered, false if queued or dropped.
	constructor(private readonly onAdvice: (note: string, severity?: AdvisorSeverity) => boolean) {}

	resetDelivered(): void {
		this.#delivered.clear();
	}

	/**
	 * Record a note as delivered so a later same-or-lower-severity repeat is
	 * deduped. Called by the catch-up block when it steers a held note in (held
	 * notes go through `onAdvice`→false, which intentionally does NOT record, so
	 * the actual delivery point must).
	 */
	markDelivered(note: string, severity?: AdvisorSeverity): void {
		this.#delivered.set(dedupeKey(note), rankOf(severity));
	}

	async execute(_id: string, args: { note: string; severity?: AdvisorSeverity }): Promise<AgentToolResult<unknown>> {
		const key = dedupeKey(args.note);
		const rank = rankOf(args.severity);
		const prev = this.#delivered.get(key) ?? 0;
		if (rank <= prev) {
			return { content: [{ type: "text", text: "Duplicate advice ignored." }], details: { ...args, dropped: true } };
		}
		const delivered = this.onAdvice(args.note, args.severity);
		if (!delivered) {
			// Not recorded: it is queued for a boundary or dropped as stale.
			return { content: [{ type: "text", text: "Queued for boundary delivery (or dropped as stale)." }], details: { ...args, held: true } };
		}
		this.#delivered.set(key, rank);
		return { content: [{ type: "text", text: "Recorded." }], details: { ...args } };
	}
}

// ---- advisory rendering for the primary transcript ----

const ADVISOR_GUIDANCE = "weigh, don't blindly obey";
const escapeXml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Render notes as the agent-facing message body: one `<advisory>` per note.
 * `stale` adds a `context` attribute noting the advice is about an earlier step
 * (used for nits, which the advisor always raises a little behind the agent).
 * `finalAnswer` appends guidance for advice delivered as a followup to a terminal
 * message: at the moment it is steered in, the primary is stopped having returned
 * a final answer this turn — regardless of which turn generated the note. If the
 * agent acts on it, it should reply with a fresh, self-contained final answer rather
 * than a terse follow-up — so the user reads one complete answer, not a
 * back-and-forth thread it has to stitch together.
 */
export function formatAdvisoryContent(notes: readonly AdvisorNote[], opts?: { stale?: boolean; finalAnswer?: boolean }): string {
	const context = opts?.stale ? ` context="raised about an earlier step"` : "";
	const body = notes
		.map((n) => {
			const sev = n.severity ? ` severity="${n.severity}"` : "";
			return `<advisory${sev}${context} guidance="${ADVISOR_GUIDANCE}">\n${escapeXml(n.note)}\n</advisory>`;
		})
		.join("\n");
	if (!opts?.finalAnswer) return body;
	return `${body}\n\nYou had already returned a final answer to the user this turn. If you act on the advice above, respond with a new, self-contained final answer that fully stands on its own — do NOT write a terse follow-up that assumes the user read your previous message. The user should be able to read your new reply alone and get the complete answer.`;
}

/** Where the primary is in its turn lifecycle. */
export type PrimaryTurnState = "running" | "ended-terminal" | "ended-nonterminal";

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
				if (hasDiff && Array.isArray(edits)) {
					const p = (c.arguments as { path?: string }).path ?? "?";
					sub.push(`→ tool \`${c.name}\`(${p}) — ${edits.length} block(s); diff in tool result`);
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

// ---- build the persistent advisor Agent ----

function buildAdvisorAgent(opts: {
	cwd: string;
	model: Model<any>;
	thinkingLevel: string;
	systemPrompt: string;
	modelRegistry: any;
	adviseTool: AdviseTool;
}): Agent {
	const readOnly = createReadOnlyTools(opts.cwd);
	const thinkingLevel = opts.model.reasoning ? (opts.thinkingLevel as any) : ("off" as any);
	return new Agent({
		initialState: {
			systemPrompt: opts.systemPrompt,
			model: opts.model,
			thinkingLevel,
			tools: [opts.adviseTool, ...readOnly] as any,
		},
		convertToLlm,
		// The installed pi-agent-core versions disagree on whether streamFn is required in the type.
		getApiKey: (provider: string) => opts.modelRegistry.getApiKeyForProvider(provider),
	} as any);
}

// ---- AdvisorRuntime — drives the advisor agent off primary turn deltas ----

/**
 * Feeds the persistent advisor agent one delta per primary turn, serialized so
 * the agent is never prompted while already streaming. On context overflow (or
 * any history rewrite) the caller invokes `reset()`, which clears the advisor's
 * own context so the next delta replays fresh.
 */
export class AdvisorRuntime {
	#pending: string[] = [];
	// The ONE pending-advice queue. Nits, concerns, and blockers all enter here;
	// boundary policy decides which severities can leave and when.
	#advice: AdvisorNote[] = [];
	// Keys re-raised during the in-flight review; drives the post-review prune.
	#reraised: Set<string> | undefined;
	// Outcome of the most recently completed drain batch: "ok" (successful review)
	// or "failed" (errored 3x and dropped). Lets waitUntilSettled distinguish a
	// genuine settle from a give-up, so queued advice isn't delivered as confirmed.
	#lastOutcome: "ok" | "failed" | undefined;
	// Epoch of the in-flight review; advice callbacks are honored only while it still
	// matches #epoch. A reset/dispose bumps #epoch, orphaning a stale review whose
	// late advise() calls would otherwise leak into the moved-on session.
	#reviewEpoch = -1;
	#settleWaiters: Array<{ settle: () => void; cancel: () => void }> = [];
	#busy = false;
	#backlog = 0;
	#failures = 0;
	#epoch = 0;
	// Lifetime input/output/cost from advisor turns already discarded by a
	// self-compaction (#softReset). The agent's message list only holds the CURRENT
	// (post-compaction) context, so without folding these in, /advisor status would
	// undercount lifetime tokens/cost after each self-compaction. A full reset()
	// (primary compaction / new session) zeroes them — that is a fresh accounting.
	#cumInput = 0;
	#cumOutput = 0;
	#cumCost = 0;
	disposed = false;

	// Self-compact when the advisor's own context reaches this % of its window
	// (proactively, before the next review prompt). Below 100 so a fresh replay of
	// the next batch comfortably fits; the reactive stopReason=="length" path is the
	// backstop if a single batch crosses it anyway.
	private readonly compactAtPercent: number;

	constructor(
		private readonly agent: Agent,
		private readonly adviseTool: AdviseTool,
		private readonly retryDelayMs = 1000,
		private readonly onDebug?: (...a: unknown[]) => void,
		compactAtPercent = 80,
		private readonly onSettled?: (outcome: "ok" | "failed") => void,
	) {
		this.compactAtPercent = compactAtPercent;
	}

	/**
	 * Self-compaction: clear ONLY the advisor agent's own message history,
	 * preserving pending deltas/advice, backlog, failure count, and settle waiters.
	 * Safe because the agent transcript is a pure linear accumulation of independent
	 * turn deltas — no essential cross-turn state lives there (held
	 * notes ride the reconfirm preamble). Unlike reset(), this does NOT bump the
	 * epoch (the in-flight review is ours, not orphaned) nor drop queued/held work.
	 */
	#softReset(): void {
		// Preserve lifetime token/cost accounting before the about-to-be-cleared
		// messages are gone (see #cumInput/#cumOutput/#cumCost).
		for (const m of this.agent.state.messages) {
			if (m.role === "assistant" && (m as AssistantMessage).usage) {
				const u = (m as AssistantMessage).usage;
				this.#cumInput += u.input ?? 0;
				this.#cumOutput += u.output ?? 0;
				this.#cumCost += u.cost?.total ?? 0;
			}
		}
		try {
			this.agent.abort();
		} catch {}
		try {
			this.agent.reset();
		} catch {}
	}

	get backlog(): number {
		return this.#backlog;
	}

	/** True when no batch is in flight and nothing is queued: the advisor has
	 *  reviewed everything pushed so far ("settled"). */
	get idle(): boolean {
		return !this.#busy && this.#pending.length === 0;
	}

	/** Whether the shared queue contains anything worth blocking a mid-run turn for. */
	get hasHighPriority(): boolean {
		return this.#advice.some((n) => isHighSeverity(n.severity));
	}

	#upsertAdvice(note: string, severity?: AdvisorSeverity): void {
		if (this.disposed) return;
		const key = dedupeKey(note);
		const existing = this.#advice.find((n) => dedupeKey(n.note) === key);
		if (!existing) this.#advice.push({ note, severity });
		else if (rankOf(severity) > rankOf(existing.severity)) existing.severity = severity;
	}

	/** Advisor observation: upsert and count as a genuine reconfirmation. */
	enqueueAdvice(note: string, severity?: AdvisorSeverity): void {
		if (this.disposed) return;
		this.#reraised?.add(dedupeKey(note));
		this.#upsertAdvice(note, severity);
	}

	/** Boundary bookkeeping: put advice back without faking a reconfirmation. */
	requeueAdvice(note: string, severity?: AdvisorSeverity): void {
		this.#upsertAdvice(note, severity);
	}

	/** Drain nits only; concerns/blockers remain queued for reconfirmation. */
	takeNits(): AdvisorNote[] {
		const nits = this.#advice.filter((n) => !isHighSeverity(n.severity));
		this.#advice = this.#advice.filter((n) => isHighSeverity(n.severity));
		return nits;
	}

	/** Drain every queued survivor after successful boundary reconciliation. */
	takeAllAdvice(): AdvisorNote[] {
		return this.#advice.splice(0);
	}

	/** Whether advice from the in-flight review is still valid (not orphaned by a
	 *  reset/dispose). The delivery layer consults this to drop late stale callbacks. */
	get acceptingAdvice(): boolean {
		return !this.disposed && this.#reviewEpoch === this.#epoch;
	}

	/**
	 * Resolve once the advisor has caught up (`idle`), or `timeoutMs` elapses, or
	 * `signal` aborts. Drives the per-turn catch-up block. Resolves "settled"
	 * immediately if already idle/disposed.
	 */
	waitUntilSettled(timeoutMs: number, signal?: AbortSignal): Promise<"settled" | "timeout" | "aborted" | "failed"> {
		if (this.disposed) return Promise.resolve("aborted");
		if (this.idle) return Promise.resolve(this.#lastOutcome === "failed" ? "failed" : "settled");
		return new Promise((resolve) => {
			let done = false;
			let waiter: { settle: () => void; cancel: () => void };
			let timer: ReturnType<typeof setTimeout>;
			const finish = (r: "settled" | "timeout" | "aborted" | "failed") => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				const i = this.#settleWaiters.indexOf(waiter);
				if (i >= 0) this.#settleWaiters.splice(i, 1);
				signal?.removeEventListener("abort", onAbort);
				resolve(r);
			};
			const onAbort = () => finish("aborted");
			waiter = {
				// Fired when the drain reaches idle (a review completed).
				settle: () => {
					if (this.disposed) finish("aborted");
					else if (this.idle) finish(this.#lastOutcome === "failed" ? "failed" : "settled");
				},
				// Fired by reset()/dispose(): resolve immediately rather than waiting for
				// the in-flight prompt to unwind (which could take up to the timeout).
				cancel: () => finish("aborted"),
			};
			timer = setTimeout(() => finish("timeout"), timeoutMs);
			this.#settleWaiters.push(waiter);
			if (signal) {
				if (signal.aborted) finish("aborted");
				else signal.addEventListener("abort", onAbort);
			}
		});
	}

	#notifySettled(): void {
		for (const w of [...this.#settleWaiters]) w.settle();
	}

	/** Resolve all pending waiters as "aborted" (used by reset/dispose). */
	#cancelWaiters(): void {
		for (const w of [...this.#settleWaiters]) w.cancel();
	}

	get usage(): { input: number; output: number; cost: number; contextTokens: number; contextPercent: number | null } {
		let input = this.#cumInput;
		let output = this.#cumOutput;
		let cost = this.#cumCost;
		let contextTokens = 0;
		for (const m of this.agent.state.messages) {
			if (m.role === "assistant" && (m as AssistantMessage).usage) {
				const u = (m as AssistantMessage).usage;
				input += u.input ?? 0;
				output += u.output ?? 0;
				cost += u.cost?.total ?? 0;
				// Latest request's input + cache reads ≈ current advisor context size.
				contextTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
			}
		}
		const window = (this.agent.state.model as { contextWindow?: number } | undefined)?.contextWindow;
		const contextPercent = window ? Math.round((contextTokens / window) * 100) : null;
		return { input, output, cost, contextTokens, contextPercent };
	}

	/** Queue a rendered primary-turn delta (markdown string) for review. */
	push(deltaText: string): void {
		if (this.disposed || !deltaText.trim()) return;
		this.#pending.push(deltaText);
		this.#backlog++;
		void this.#drain();
	}

	/** Re-prime after a history rewrite (compaction / session switch / fork). */
	reset(): void {
		this.#epoch++;
		this.#pending = [];
		this.#advice = [];
		this.#reraised = undefined;
		this.#lastOutcome = undefined;
		this.#backlog = 0;
		this.#failures = 0;
		// Full reset = fresh accounting (unlike #softReset, which preserves these).
		this.#cumInput = this.#cumOutput = this.#cumCost = 0;
		this.adviseTool.resetDelivered();
		try {
			this.agent.abort();
		} catch {}
		try {
			this.agent.reset();
		} catch {}
		this.#cancelWaiters();
	}

	dispose(): void {
		this.disposed = true;
		this.#epoch++;
		this.#pending = [];
		this.#advice = [];
		this.#reraised = undefined;
		this.#lastOutcome = undefined;
		this.#backlog = 0;
		try {
			this.agent.abort();
		} catch {}
		this.#cancelWaiters();
	}

	async #drain(): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			while (!this.disposed && this.#pending.length) {
				const batch = this.#pending.splice(0);
				const turns = batch.length;
				// Rough gauge of how many turns are still unreviewed (status display only).
				this.#backlog = Math.max(0, this.#backlog - turns);
				const epoch = this.#epoch;
				// Re-offer the shared advice queue without removing it. On success, entries
				// not re-raised are resolved and pruned. Snapshot by value so a discarded
				// overflow attempt can restore prior severities without resurrecting entries
				// concurrently drained at a primary turn boundary.
				const offered = this.#advice.map((n) => ({ ...n }));
				const offeredKeys = new Set(offered.map((n) => dedupeKey(n.note)));
				const preamble = formatReconfirmPreamble(offered);
				this.#reraised = new Set();
				this.#reviewEpoch = epoch;
				const messages = buildReviewMessages(preamble, batch);
				const promptChars = messages.reduce(
					(n, m) =>
						n +
						(Array.isArray(m.content)
							? m.content.reduce(
									(k: number, b: { type: string; text?: string }) => k + (b.type === "text" ? (b.text?.length ?? 0) : 0),
									0,
								)
							: 0),
					0,
				);
				// A review "fails" either by throwing OR — the common case — by resolving
				// with an assistant message whose stopReason is "error"/"aborted" (the agent
				// loop records provider failures that way instead of throwing). A failed
				// review must NOT prune queued advice (we'd drop it as if recanted).
				let failed = false;
				// PROACTIVE self-compaction: if our own context has crossed the budget,
				// clear the agent history now so this batch replays into a fresh context
				// (queued advice survives via the reconfirm preamble) instead of marching into
				// an overflow. Skipped when already fresh (nothing to reclaim).
				const pct = this.usage.contextPercent;
				if (pct !== null && pct >= this.compactAtPercent && this.agent.state.messages.length > 0) {
					this.onDebug?.("advisor self-compacting (proactive), ctx=", pct, "% >=", this.compactAtPercent, "%");
					this.#softReset();
				}
				let stale = false;
				try {
					// Inner loop: at most ONE reactive self-compaction retry. If the
					// advisor's own context overflows mid-review (stopReason "length"), clear
					// its history and replay THIS batch into a fresh context instead of
					// counting a failure and retrying 3x into the same wall. Loop-safe: a
					// fresh replay that STILL overflows means the single batch genuinely
					// doesn't fit, so it falls through to the failed handling below.
					let last: AssistantMessage | undefined;
					for (let attempt = 0; attempt < 2; attempt++) {
						this.onDebug?.("prompting advisor agent, delta chars=", promptChars, "held=", offered.length);
						await this.agent.prompt(messages);
						if (this.#epoch !== epoch) {
							stale = true;
							break; // reset/dispose during the prompt; batch is stale
						}
						last = this.agent.state.messages[this.agent.state.messages.length - 1] as AssistantMessage;
						if (last?.stopReason === "length" && attempt === 0) {
							this.onDebug?.("advisor context overflow, self-compacting (reactive) and replaying batch fresh");
							this.#softReset();
							// Roll back attempt-only queue mutations by intersection. Concurrently
							// drained entries stay gone; surviving pre-attempt entries regain severity.
							const before = new Map(offered.map((n) => [dedupeKey(n.note), n]));
							this.#advice = this.#advice.flatMap((current) => {
								const prior = before.get(dedupeKey(current.note));
								return prior ? [{ ...current, severity: prior.severity }] : [];
							});
							this.#reraised = new Set();
							continue;
						}
						break;
					}
					if (stale) {
						this.#reraised = undefined;
						continue;
					}
					if (last?.stopReason === "error" || last?.stopReason === "aborted" || last?.stopReason === "length") {
						// error/aborted = provider failure (recorded, not thrown); length =
						// truncated review (a fresh replay still didn't fit) — in all three the
						// advisor didn't finish, so don't prune queued advice on its accidental
						// "silence".
						this.onDebug?.("advisor review incomplete, stop=", last?.stopReason, "err=", last?.errorMessage ?? "-");
						failed = true;
					} else {
						// Success: prune offered queue entries the advisor stayed silent on.
						for (const key of offeredKeys) {
							if (!this.#reraised?.has(key)) {
								const i = this.#advice.findIndex((n) => dedupeKey(n.note) === key);
								if (i >= 0) this.#advice.splice(i, 1);
							}
						}
						this.#lastOutcome = "ok";
						this.#failures = 0;
						this.onDebug?.("advisor turn done, stop=", last?.stopReason);
					}
					this.#reraised = undefined;
				} catch (e) {
					this.#reraised = undefined;
					this.onDebug?.("advisor prompt threw", String(e));
					// A reset/dispose aborts the in-flight prompt; drop the stale batch.
					// Held notes were never removed, so nothing to restore there.
					if (this.#epoch !== epoch) continue;
					failed = true;
				}
				if (failed) {
					this.#failures++;
					if (this.#failures >= 3) {
						// Gave up reconfirming this batch. Mark failed so waitUntilSettled
						// reports it (don't deliver held notes as if confirmed).
						this.#failures = 0;
						this.#lastOutcome = "failed";
					} else {
						this.#pending.unshift(...batch);
						this.#backlog += turns;
						await new Promise((r) => setTimeout(r, this.retryDelayMs));
					}
				}
			}
		} finally {
			this.#busy = false;
			if (this.idle) {
				this.#notifySettled();
				try {
					this.onSettled?.(this.#lastOutcome === "failed" ? "failed" : "ok");
				} catch (e) {
					this.onDebug?.("advisor onSettled callback threw", String(e));
				}
			}
		}
	}
}

// ===========================================================================
// Extension wiring
// ===========================================================================

const ADVISORY_TYPE = "advisory";
// Footer status key. Statuses are ordered alphabetically by key; "q-advisor"
// sorts after "permissions"/"provider-system-prompt" but before "sub-bar", so
// Advisor shows as a middle segment. Change this to reposition it (e.g.
// "a-advisor" for leftmost).
const STATUS_KEY = "q-advisor";
const DEBUG = !!process.env.ADVISOR_DEBUG;
const dbg = (...a: unknown[]) => {
	if (DEBUG) console.error("[advisor]", ...a);
};
const BLOCK_BASE_MS = 15_000;
const BLOCK_CAP_MS = 120_000;

// Set by the handoff extension (pi-amplike) via the same Symbol.for key while a
// handoff is in flight — from the moment it becomes pending until the new
// session's prompt has been dispatched. During that window the primary session
// is being torn down / replaced and its deferred handoff prompt is racing to be
// sent, so the advisor must not inject messages or (worse) trigger an
// autonomous turn: doing so either crashes the handoff ("Agent is already
// processing") or leaks a stray advisory into the brand-new session.
const HANDOFF_IN_PROGRESS_KEY = Symbol.for("pi-amplike-handoff-in-progress");
function handoffInProgress(): boolean {
	return !!(globalThis as any)[HANDOFF_IN_PROGRESS_KEY];
}

// Emitted by the handoff extension after its tool path replaces the session
// transcript via the low-level sessionManager.newSession() (which emits no
// session_start). Must match HANDOFF_SESSION_REPLACED_CHANNEL in handoff.ts.
const HANDOFF_SESSION_REPLACED_CHANNEL = "pi-amplike:handoff-session-replaced";
const DEFAULT_ADVISOR_PROVIDER = "openrouter";
const DEFAULT_ADVISOR_MODEL = "z-ai/glm-5.2";
const DEFAULT_THINKING = "low";
const ADVISOR_SYSTEM_PROMPT = fs
	.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../advisor-system.md"), "utf8")
	.trim();
function loadSystemPrompt(cwd: string): string {
	let prompt = ADVISOR_SYSTEM_PROMPT;
	// Append WATCHDOG.md (advisor-only project guidance) if present in cwd.
	try {
		const wd = fs.readFileSync(path.join(cwd, "WATCHDOG.md"), "utf8").trim();
		if (wd) prompt += `\n\nEspecially pay attention to:\n<attention>\n${wd}\n</attention>`;
	} catch {}
	return prompt;
}

type WorkflowCore = { registerWorkflowExtension?: (extension: unknown) => void };
type WorkflowUtils = { disabledResources?: (patterns: readonly string[], resources: readonly string[]) => string[] };
export type AdvisorBridgeSpec = { advisorPath: string; jitiPath: string; aliases: Readonly<Record<string, string>> };
type AdvisorExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
let workflowIntegrationRegistered = false;

function loadWorkflowCore(): WorkflowCore | undefined {
	try {
		return createRequire(import.meta.url)("pi-extensible-workflows") as WorkflowCore;
	} catch {
		return undefined;
	}
}

function loadWorkflowUtils(): WorkflowUtils | undefined {
	try {
		return createRequire(import.meta.url)("pi-extensible-workflows/utils") as WorkflowUtils;
	} catch {
		return undefined;
	}
}

function runtimePackageRoot(entrypoint: string | undefined): string | undefined {
	if (!entrypoint) return undefined;
	try { entrypoint = fs.realpathSync(path.resolve(entrypoint)); } catch { entrypoint = path.resolve(entrypoint); }
	let current = path.dirname(entrypoint);
	for (;;) {
		if (fs.existsSync(path.join(current, "package.json")) && fs.existsSync(path.join(current, "dist", "index.js"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function runtimeFile(root: string, relative: string): string | undefined {
	const candidates = [
		path.join(root, "node_modules", relative),
		path.join(root, "..", "node_modules", relative),
		path.join(root, "..", "..", "node_modules", relative),
	];
	return candidates.find((candidate) => fs.existsSync(candidate));
}

export function resolveAdvisorBridgeSpec(entrypoint = process.argv[1]): AdvisorBridgeSpec | undefined {
	const root = runtimePackageRoot(entrypoint);
	if (!root) return undefined;
	const advisorPath = fileURLToPath(import.meta.url);
	const jitiPath = runtimeFile(root, "jiti/lib/jiti.cjs");
	const codingAgent = path.join(root, "dist", "index.js");
	const agentCore = runtimeFile(root, "@earendil-works/pi-agent-core/dist/index.js");
	const aiCompat = runtimeFile(root, "@earendil-works/pi-ai/dist/compat.js");
	const piTui = runtimeFile(root, "@earendil-works/pi-tui/dist/index.js");
	const typebox = runtimeFile(root, "typebox/build/index.mjs");
	const typeboxCompile = runtimeFile(root, "typebox/build/compile/index.mjs");
	const typeboxValue = runtimeFile(root, "typebox/build/value/index.mjs");
	if (!jitiPath || !fs.existsSync(codingAgent) || !agentCore || !aiCompat || !piTui || !typebox || !typeboxCompile || !typeboxValue) return undefined;
	const aliases: Record<string, string> = {
		"@earendil-works/pi-coding-agent": codingAgent,
		"@earendil-works/pi-agent-core": agentCore,
		"@earendil-works/pi-ai": aiCompat,
		"@earendil-works/pi-ai/compat": aiCompat,
		"@earendil-works/pi-tui": piTui,
		typebox,
		"typebox/compile": typeboxCompile,
		"typebox/value": typeboxValue,
		"@mariozechner/pi-coding-agent": codingAgent,
		"@mariozechner/pi-agent-core": agentCore,
		"@mariozechner/pi-ai": aiCompat,
		"@mariozechner/pi-tui": piTui,
		"@sinclair/typebox": typebox,
		"@sinclair/typebox/compile": typeboxCompile,
		"@sinclair/typebox/value": typeboxValue,
	};
	return { advisorPath, jitiPath, aliases };
}
export function advisorResourceAllowed(patterns: readonly string[], advisorPath = fileURLToPath(import.meta.url)): boolean {
	if (!patterns.length) return true;
	const disabledResources = loadWorkflowUtils()?.disabledResources;
	if (typeof disabledResources !== "function") return false;
	return disabledResources(patterns, [advisorPath]).length === 0;
}

export function createAdvisorBridgeFactory(state: AdvisorSessionState, spec = resolveAdvisorBridgeSpec()): AdvisorExtensionFactory | undefined {
	if (!spec) return undefined;
	const source = `return async function piOmplikeAdvisorBridge(pi) {\n` +
		`const module = await import(${JSON.stringify(pathToFileURL(spec.jitiPath).href)});\n` +
		`const createJiti = module.default ?? module.createJiti;\n` +
		`if (typeof createJiti !== "function") throw new Error("Pi runtime jiti is unavailable");\n` +
		`const jiti = createJiti(${JSON.stringify(spec.advisorPath)}, { moduleCache: false, alias: ${JSON.stringify(spec.aliases)} });\n` +
		`const extension = await jiti.import(${JSON.stringify(spec.advisorPath)}, { default: true });\n` +
		`if (typeof extension !== "function") throw new Error("Advisor extension has no default factory");\n` +
		`await extension(pi, ${JSON.stringify(copyAdvisorSessionState(state))});\n` +
		`};`;
	return new Function(source)() as AdvisorExtensionFactory;
}

export function registerAdvisorWorkflowIntegration(load: () => WorkflowCore | undefined = loadWorkflowCore): boolean {
	if (workflowIntegrationRegistered) return true;
	const core = load();
	if (typeof core?.registerWorkflowExtension !== "function") return false;
	try {
		core.registerWorkflowExtension({
			version: "0.1.0",
			headline: "Inherited workflow advisor",
			agentSetupHooks: {
				piOmplikeAdvisor: {
					setup(agent: any, context: any) {
						const sessionId = context.run.sessionId as string;
						const runId = context.run.runId as string;
						let inherited = workflowRunStates.get(runId)?.state;
						if (!inherited) {
							inherited = copyAdvisorSessionState(workflowSessionStates.get(sessionId) ?? { enabled: false });
							workflowRunStates.set(runId, { sessionId, state: inherited });
						}
						if (!inherited.enabled) return;
						const spec = resolveAdvisorBridgeSpec();
						if (!spec) throw new Error("Advisor workflow bridge requires the originating Node Pi runtime");
						if (!advisorResourceAllowed(agent.sessionInput.resourcePolicy?.effective?.extensions ?? [], spec.advisorPath)) return;
						const factory = createAdvisorBridgeFactory(inherited, spec);
						if (!factory) return;
						agent.sessionInput.extensionFactories ??= [];
						agent.sessionInput.extensionFactories.push(factory);
					},
				},
			},
		});
		workflowIntegrationRegistered = true;
		return true;
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === "DUPLICATE_NAME") {
			workflowIntegrationRegistered = true;
			return true;
		}
		if (code === "REGISTRY_FROZEN") return false;
		throw error;
	}
}

function installAdvisor(pi: ExtensionAPI, inheritedState: AdvisorSessionState = { enabled: false }): void {
	let sessionState: AdvisorSessionState = { enabled: false };
	let enabled = false;
	let runtime: AdvisorRuntime | undefined;
	let activeModelLabel: string | undefined;
	let builtForCwd: string | undefined;
	let builtConfigKey: string | undefined;
	let pendingRuntimeRebuild = false;
	let turnRunning = false;
	let turnConfig: AdvisorSessionState = { enabled: false };
	let carriedAdvice: AdvisorNote[] = [];
	let warnedUnavailableModelKey: string | undefined;
	let activeSessionId: string | undefined;

	const copyState = copyAdvisorSessionState;
	const configKey = (state: AdvisorSessionState): string => JSON.stringify({ model: state.model, thinkingLevel: state.thinkingLevel });

	function persistState(): void {
		pi.appendEntry(ADVISOR_STATE_TYPE, {
			enabled: sessionState.enabled,
			model: sessionState.model ?? null,
			thinkingLevel: sessionState.thinkingLevel ?? null,
		});
	}

	function setSessionState(next: AdvisorSessionState, persist = true): void {
		const configChanged = configKey(next) !== configKey(sessionState);
		sessionState = copyState(next);
		enabled = sessionState.enabled;
		if (activeSessionId) workflowSessionStates.set(activeSessionId, copyState(sessionState));
		if (configChanged) pendingRuntimeRebuild = true;
		if (persist) persistState();
	}

	function restoreSessionState(ctx: any): void {
		activeSessionId = String(ctx.sessionManager.getSessionId?.() ?? "");
		sessionState = readAdvisorSessionState(ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries(), inheritedState);
		enabled = sessionState.enabled;
		turnConfig = copyState(sessionState);
		pendingRuntimeRebuild = false;
		carriedAdvice = [];
		if (activeSessionId) workflowSessionStates.set(activeSessionId, copyState(sessionState));
	}

	// Lazily-built advisor state, rebuilt when cwd/model changes or session resets.
	// Model changes never dispose a busy runtime; the replacement is made at a safe boundary.


	// Delta accumulation across the lifecycle.
	let pendingUserPrompt: string | undefined;

	// The advise tool bound to the live runtime (held so the catch-up block can
	// mark held notes delivered at the actual delivery point).
	let adviseTool: AdviseTool | undefined;

	// Consecutive mid-run catch-up blocks, for the backoff (reset when the advisor
	// settles or a turn doesn't need to block).
	let consecutiveBlocks = 0;

	// Set when the user aborts (Escape) around a catch-up block: while true, late
	// advisor advice is delivered WITHOUT triggerTurn so it can't auto-resume the run
	// the user just stopped. Cleared when the user drives the next turn.
	let autoResumeSuppressed = false;

	// One source of truth for which primary boundary a queue flush belongs to.
	let turnState: PrimaryTurnState = "ended-nonterminal";

	// ---- statusbar: minimalistic per-session advisor cost ----
	// Reflects the live advisor lifetime cost (rt.usage.cost) in the footer status
	// bar as `│ Advisor: $N`. Cleared when the advisor is off or torn down.
	//
	// Footer ordering: pi sorts extension statuses alphabetically BY KEY and joins
	// them with a single space (no separators of its own). So the key controls
	// position and we draw our own `│` divider in the text. STATUS_KEY sorts after
	// "permissions"/"provider-system-prompt" but before "sub-bar", placing Advisor as
	// a middle segment rather than the leftmost.
	//
	// LEADING bar only (no trailing): whatever follows draws its own separator
	// (e.g. pi-sub-bar with statusLeadingDivider:true starts with `│`), so a trailing
	// bar here would double up (`│ Advisor │ │ …`).
	function updateStatus(ctx: unknown): void {
		const ui = (ctx as {
			ui?: { setStatus?: (k: string, t: string | undefined) => void; theme?: { fg: (c: string, s: string) => string } };
		}).ui;
		if (!ui?.setStatus) return;
		if (!enabled || !runtime) {
			ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const bar = ui.theme ? ui.theme.fg("dim", "│") : "│";
		ui.setStatus(STATUS_KEY, `${bar} Advisor: $${runtime.usage.cost.toFixed(2)}`);
	}

	// ---- advice delivery into the primary session ----
	function sendNit(note: string, severity: AdvisorSeverity | undefined, finalAnswer: boolean): void {
		const notes: AdvisorNote[] = [{ note, severity }];
		const content = formatAdvisoryContent(notes, { stale: true, finalAnswer });
		pi.sendMessage(
			{ customType: ADVISORY_TYPE, content, display: true, details: { notes } },
			{ deliverAs: "steer", triggerTurn: !autoResumeSuppressed },
		);
	}

	// The only immediate boundary flush: non-terminal turns drain queued nits.
	// Concerns/blockers stay in the same queue for review reconfirmation.
	function flushNits(rt: AdvisorRuntime | undefined): void {
		if (!rt || handoffInProgress()) return;
		for (const n of rt.takeNits()) {
			sendNit(n.note, n.severity, false);
			adviseTool?.markDelivered(n.note, n.severity);
		}
	}

	// Advisor callbacks only enqueue. Delivery policy lives at primary boundaries,
	// where terminality and reconfirmation state are actually known.
	function deliverAdvice(note: string, severity?: AdvisorSeverity, sourceRuntime?: AdvisorRuntime): boolean {
		// Stand down entirely while a handoff is being performed (see comment on
		// HANDOFF_IN_PROGRESS_KEY).
		if (handoffInProgress()) {
			dbg("handoff in progress, dropping advice", severity, JSON.stringify(note).slice(0, 80));
			// False means "not delivered", so AdviseTool does not poison the fresh
			// session's dedup map with a dropped callback.
			return false;
		}
		// Drop late callbacks the session has moved past: advisor turned off, or a
		// reset/dispose orphaned the in-flight review (its epoch no longer matches).
		const targetRuntime = sourceRuntime ?? runtime;
		if (!enabled || (sourceRuntime && sourceRuntime !== runtime) || (targetRuntime && !targetRuntime.acceptingAdvice)) {
			dbg("dropping stale/disabled advice", severity, JSON.stringify(note).slice(0, 80));
			// Especially after reset/replacement, never let an old callback enqueue into
			// the fresh runtime or poison its cleared dedup map.
			return false;
		}

		if (targetRuntime) {
			targetRuntime.enqueueAdvice(note, severity);
			dbg("queued advice", severity, JSON.stringify(note).slice(0, 120));
			return false; // AdviseTool records only at the real boundary delivery.
		}

		// Hidden no-model test hook only: production advisor callbacks always have the
		// runtime that created their AdviseTool. Keep idle command testing convenient.
		if (!isHighSeverity(severity) && turnState !== "running") {
			sendNit(note, severity, turnState === "ended-terminal");
			return true;
		}
		return false;
	}

	// ---- steer held survivors into the primary (called by the catch-up block) ----
	function deliverHeld(notes: AdvisorNote[], opts?: { terminal?: boolean }): void {
		if (handoffInProgress() || !notes.length) return;
		// A held note restates iff it is delivered from a terminal turn's catch-up.
		// turnState was set synchronously at turn_end before the block began.
		const finalAnswer = turnState === "ended-terminal";
		if (opts && opts.terminal !== undefined && opts.terminal !== finalAnswer)
			dbg("deliverHeld: opts.terminal diverged from turnState", opts.terminal, turnState);
		for (const n of notes) {
			dbg("deliverHeld", n.severity, JSON.stringify(n.note).slice(0, 120));
			const content = formatAdvisoryContent([n], { finalAnswer, stale: !isHighSeverity(n.severity) });
			pi.sendMessage({ customType: ADVISORY_TYPE, content, display: true, details: { notes: [n] } }, { deliverAs: "steer", triggerTurn: !autoResumeSuppressed });
			// Record at the real delivery point (onAdvice→false never recorded it), so a
			// later same-or-lower-severity repeat is deduped.
			adviseTool?.markDelivered(n.note, n.severity);
		}
	}

	// Reviews can finish after a primary turn_end timeout. Reuse the same boundary
	// policy instead of creating a late-callback delivery path. This synchronous
	// callback drains before a runTurnBlock waiter resumes; the latter then sees empty.
	function flushSettledAdvice(outcome: "ok" | "failed"): void {
		if (outcome !== "ok" || !runtime || handoffInProgress()) return;
		if (turnState === "ended-terminal") {
			const notes = runtime.takeAllAdvice();
			if (notes.length) deliverHeld(notes, { terminal: true });
		} else if (turnState === "ended-nonterminal") {
			flushNits(runtime);
		}
	}

	function teardown(preserveBoundary = false): void {
		runtime?.dispose();
		runtime = undefined;
		adviseTool = undefined;
		activeModelLabel = undefined;
		builtForCwd = undefined;
		builtConfigKey = undefined;
		pendingUserPrompt = undefined;
		warnedUnavailableModelKey = undefined;
		if (!preserveBoundary) {
			consecutiveBlocks = 0;
			autoResumeSuppressed = false;
			turnRunning = false;
			turnState = "ended-nonterminal";
		}
	}

	function retireRuntimeForRebuild(): void {
		if (runtime) carriedAdvice.push(...runtime.takeAllAdvice());
		teardown(true);
	}
	// Re-prime for a replaced transcript without tearing down the advisor agent:
	// clear its context so the next delta replays fresh. Used by both the
	// session_start handler and the handoff session-replaced signal so the two
	// paths can't drift.
	function resetAdvisorState(): void {
		runtime?.reset();
		pendingUserPrompt = undefined;
		consecutiveBlocks = 0;
		warnedUnavailableModelKey = undefined;
		autoResumeSuppressed = false;
		turnRunning = false;
		turnConfig = copyState(sessionState);
		turnState = "ended-nonterminal";
	}

	// ---- build the advisor agent lazily (needs ctx for model/registry/cwd) ----
	async function ensureRuntime(
		ctx: { cwd: string; modelRegistry: any; model: any },
		state: AdvisorSessionState = sessionState,
	): Promise<AdvisorRuntime | undefined> {
		const wantedKey = configKey(state);
		const configMatches = runtime !== undefined && builtForCwd === ctx.cwd && builtConfigKey === wantedKey;
		const policy = advisorRuntimeChangePolicy(runtime !== undefined && !runtime.idle, configMatches);
		if (runtime && policy === "reuse") {
			pendingRuntimeRebuild = configKey(sessionState) !== wantedKey;
			return runtime;
		}
		if (runtime && builtForCwd !== ctx.cwd) retireRuntimeForRebuild();
		if (runtime && policy === "defer") {
			// A model change must not abort a review already in flight. The settled
			// callback tears this runtime down so the next primary turn rebuilds it.
			pendingRuntimeRebuild = true;
			return runtime;
		}
		if (runtime) retireRuntimeForRebuild();
		if (!ctx.modelRegistry?.find) return undefined;

		let model: any;
		let thinkingLevel = DEFAULT_THINKING;
		let modeModel: any;
		try {
			const spec = await loadModeSpec(ctx.cwd, "advisor");
			if (spec?.provider && spec.modelId) modeModel = ctx.modelRegistry.find(spec.provider, spec.modelId);
			if (spec?.thinkingLevel) thinkingLevel = spec.thinkingLevel;
		} catch {}
		if (state.model) model = ctx.modelRegistry.find(state.model.provider, state.model.modelId);
		const fallbackModel = modeModel ?? ctx.modelRegistry.find(DEFAULT_ADVISOR_PROVIDER, DEFAULT_ADVISOR_MODEL);
		if (!model && warnedUnavailableModelKey !== wantedKey) {
			if (state.model) {
				const fallback = fallbackModel ? `${fallbackModel.provider}/${fallbackModel.id}` : "no advisor model is available";
				const fallbackText = fallbackModel ? `using ${fallback}` : fallback;
				(ctx as any).ui?.notify?.(
					`advisor model ${state.model.provider}/${state.model.modelId} is unavailable; ${fallbackText}`,
					"warning",
				);
			} else {
				(ctx as any).ui?.notify?.("no advisor model is available", "warning");
			}
			warnedUnavailableModelKey = wantedKey;
		}
		model ??= fallbackModel;
		if (state.thinkingLevel) thinkingLevel = state.thinkingLevel;
		if (!model) return undefined;

		let builtRuntime!: AdvisorRuntime;
		const builtAdviseTool = new AdviseTool((note, severity) => deliverAdvice(note, severity, builtRuntime));
		adviseTool = builtAdviseTool;
		const agent = buildAdvisorAgent({
			cwd: ctx.cwd,
			model,
			thinkingLevel,
			systemPrompt: loadSystemPrompt(ctx.cwd),
			modelRegistry: ctx.modelRegistry,
			adviseTool: builtAdviseTool,
		});
		// ADVISOR_COMPACT_AT: % of the advisor's context window at which it self-
		// compacts (clamped 50..95; default 80).
		const compactAt = Math.min(95, Math.max(50, Number(process.env.ADVISOR_COMPACT_AT) || 80));
		builtRuntime = new AdvisorRuntime(agent, builtAdviseTool, 1000, dbg, compactAt, (outcome) => {
			// A disposed/replaced runtime may settle late; never let it flush the new one.

			if (runtime === builtRuntime) {
				flushSettledAdvice(outcome);
				if (runtime === builtRuntime && pendingRuntimeRebuild && builtRuntime.idle && !turnRunning) retireRuntimeForRebuild();
			}
		});
		runtime = builtRuntime;
		activeModelLabel = `${model.provider}/${model.id}`;
		builtForCwd = ctx.cwd;
		builtConfigKey = wantedKey;
		for (const note of carriedAdvice.splice(0)) builtRuntime.requeueAdvice(note.note, note.severity);
		pendingRuntimeRebuild = configKey(sessionState) !== wantedKey;
		dbg("built advisor runtime, model=", activeModelLabel);
		return runtime;
	}

	// ---- event wiring ----

	// User preflight happens before Pi starts streaming, so mark the turn running
	// here as well as at turn_start. This closes the only real pre-turn window without
	// consulting isIdle() or maintaining a second terminal flag.
	function startTurn(): void {
		if (turnRunning) return;
		if (pendingRuntimeRebuild && runtime?.idle) retireRuntimeForRebuild();
		turnConfig = copyState(sessionState);
		turnRunning = true;
		autoResumeSuppressed = false;
		turnState = "running";
	}

	pi.on("before_agent_start", (event) => {
		if (!enabled) return;
		startTurn();
		pendingUserPrompt = event.prompt;
	});

	// Fires for every assistant turn, including advisory-triggered runs and same-run
	// continuations. Every real turn_start is paired with turn_end (also on failure).
	pi.on("turn_start", () => {
		if (!enabled) return;
		startTurn();
	});

	// One delta per primary turn (assistant message + its tool results). After
	// pushing, run the catch-up block: this hook is awaited by the agent loop, so
	// awaiting here stalls the primary's next step until the advisor catches up.
	pi.on("turn_end", async (event, ctx) => {
		const configForTurn = copyState(turnConfig);
		try {
			// This is the authoritative boundary: Pi has finalized the assistant message,
			// and any steer observed during `running` will be inserted immediately after it.
			// Keep the running flag set until all boundary work is complete so a settled
			// callback cannot retire the runtime underneath the catch-up block.
			const terminal = isTerminalTurn(event.message as any);
			turnState = terminal ? "ended-terminal" : "ended-nonterminal";
			if (!enabled) return;

			// Test seam: skip live model review. The hidden command delivers directly when
			// no runtime exists, so no queue work is needed here.
			if (process.env.ADVISOR_NO_REVIEW) return;

			// Never wait here solely to replace a busy runtime. Queue this turn on the
			// active runtime and let its settled callback retire it at the safe boundary.
			const rt = await ensureRuntime(ctx as any, configForTurn);
			dbg("turn_end", "state=", turnState, "enabled=", enabled, "runtime=", !!rt, "model=", activeModelLabel);
			if (!rt) return;

			// At a non-terminal boundary, queued nits preserve their low-latency behavior.
			// At a terminal boundary they remain in the SAME queue and ride the final
			// review's reconfirmation preamble alongside concerns/blockers.
			if (!terminal) flushNits(rt);

			const delta = formatTurnDelta({
				userPrompt: pendingUserPrompt,
				assistant: event.message as AssistantMessage,
				toolResults: event.toolResults as ToolResultMessage[],
			});
			pendingUserPrompt = undefined;
			rt.push(delta);

			// Don't block during a handoff teardown (we'd stall the replacement).
			if (handoffInProgress()) return;
			updateStatus(ctx);
			consecutiveBlocks = await runTurnBlock({
				terminal,
				runtime: rt,
				consecutiveBlocks,
				baseMs: BLOCK_BASE_MS,
				capMs: BLOCK_CAP_MS,
				signal: (ctx as any).signal,
				notify: (m) => {
					try {
						(ctx as any).ui?.notify?.(m, "info");
					} catch {}
				},
				deliverHeld,
			});
			// If the user aborted (Escape) around the block, suppress auto-resume so a late
			// advisor callback from the still-running review can't restart the stopped run.
			if ((ctx as any).signal?.aborted) autoResumeSuppressed = true;
			// Refresh the footer cost after the advisor caught up (review cost is now in).
			updateStatus(ctx);
		} finally {
			turnRunning = false;
		}
	});

	// Re-prime the advisor when the primary transcript is rewritten.
	pi.on("session_compact", (_event, ctx) => {
		runtime?.reset();
		updateStatus(ctx);
	});
	pi.on("session_start", (event, ctx) => {
		restoreSessionState(ctx);
		// new/resume/fork replace history; reload/startup restore the current branch too.
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") resetAdvisorState();
		updateStatus(ctx);
	});

	// Tool-path handoff replaces the transcript without a session_start event
	// (low-level sessionManager.newSession()), so reset off this explicit signal.
	pi.events.on(HANDOFF_SESSION_REPLACED_CHANNEL, () => resetAdvisorState());
	pi.events.on("workflow:run-state-changed", (event: any) => {
		if (["completed", "failed", "stopped"].includes(event?.state)) workflowRunStates.delete(event.runId);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		teardown();
		if (activeSessionId) {
			workflowSessionStates.delete(activeSessionId);
			for (const [runId, value] of workflowRunStates) if (value.sessionId === activeSessionId) workflowRunStates.delete(runId);
			activeSessionId = undefined;
		}
		(ctx as { ui?: { setStatus?: (k: string, t: string | undefined) => void } }).ui?.setStatus?.(STATUS_KEY, undefined);
	});

	// ---- advisory card rendering ----
	pi.registerMessageRenderer<{ notes: AdvisorNote[] }>(ADVISORY_TYPE, (message, _options, theme) => {
		const notes = message.details?.notes;
		if (!notes?.length) return undefined;
		const container = new Container();
		for (const n of notes) {
			const color = n.severity === "blocker" ? "error" : n.severity === "concern" ? "warning" : "dim";
			const tag = (n.severity ?? "nit").toUpperCase();
			container.addChild(new Text(`${theme.fg(color, `◆ advisor [${tag}]`)} ${theme.fg("muted", n.note)}`, 1, 0));
		}
		return container;
	});

	// ---- /advisor command ----
	pi.registerCommand("advisor", {
		description: "Toggle/inspect the advisor. Usage: /advisor [on|off|status|model]",
		handler: async (args, ctx) => {
			const rawArg = args.trim();
			const arg = rawArg.toLowerCase();

			if (arg === "status" || arg === "") {
				const state = enabled ? "enabled" : "disabled";
				if (!enabled) {
					ctx.ui.notify(`advisor ${state}`, "info");
					updateStatus(ctx);
					return;
				}
				const rt = await ensureRuntime(ctx as any);
				if (!rt) {
					ctx.ui.notify(`advisor enabled but no advisor model is available`, "warning");
					return;
				}
				updateStatus(ctx);
				const u = rt.usage;
				const ctxStr = u.contextPercent !== null ? `${u.contextPercent}% (${u.contextTokens} tok)` : `${u.contextTokens} tok`;
				ctx.ui.notify(
					`advisor ${state} — model ${activeModelLabel}, backlog ${rt.backlog}, ` +
						`tokens ${u.input}in/${u.output}out, cost $${u.cost.toFixed(4)}, ctx ${ctxStr}`,
					"info",
				);
				return;
			}

			if (arg === "on") {
				setSessionState({ ...sessionState, enabled: true });
				const rt = await ensureRuntime(ctx as any);
				updateStatus(ctx);
				ctx.ui.notify(rt ? `advisor on — ${activeModelLabel}` : `advisor on, but no advisor model available`, rt ? "info" : "warning");
				return;
			}
			if (arg === "off") {
				setSessionState({ ...sessionState, enabled: false });
				carriedAdvice = [];
				teardown();
				updateStatus(ctx);
				ctx.ui.notify("advisor off", "info");
				return;
			}

			if (arg === "model" || arg.startsWith("model ")) {
				if (arg === "model default" || arg === "model reset") {
					setSessionState({ enabled: sessionState.enabled });
					ctx.ui.notify("advisor model reset to modes.json default; applies next turn", "info");
					return;
				}
				let selected: { provider: string; modelId: string; thinkingLevel?: AdvisorThinkingLevel } | undefined;
				if (arg === "model") {
					const ui = ctx.ui;
					const canCustom = ctx.mode === "tui" && typeof (ui as any).custom === "function";
					const canSelect = typeof ui.select === "function";
					if (!(ctx as any).hasUI || (!canCustom && !canSelect)) {
						ctx.ui.notify("advisor model picker requires interactive UI", "warning");
						return;
					}
					const scoped = Array.isArray((ctx as any).scopedModels) ? (ctx as any).scopedModels : [];
					const entries = scoped.length ? scoped : (ctx.modelRegistry.getAvailable?.() ?? []).map((model: any) => ({ model }));
					if (!entries.length) {
						ctx.ui.notify("no advisor models are available", "warning");
						return;
					}
					const currentLabel = sessionState.model ? `${sessionState.model.provider}/${sessionState.model.modelId}` : activeModelLabel;
					const currentEntry = entries.find((entry: any) => `${entry.model.provider}/${entry.model.id}` === currentLabel);
					const orderedEntries = currentEntry ? [currentEntry, ...entries.filter((entry: any) => entry !== currentEntry)] : entries;
					const pickerItems = orderedEntries.map((entry: any) => ({
						provider: entry.model.provider,
						id: entry.model.id,
						name: typeof entry.model.name === "string" ? entry.model.name : undefined,
						label: `${entry.model.provider}/${entry.model.id}`,
					}));
					const modelLabel = canCustom
						? await ui.custom<string | undefined>((tui: TUI, theme: Theme, _keybindings: unknown, done: (value: string | undefined) => void) =>
							new AdvisorModelPicker(pickerItems, tui, theme, done),
						)
						: await ui.select("Advisor model", pickerItems.map((item: AdvisorModelPickerItem) => item.label));
					if (!modelLabel) return;
					const entry = entries.find((item: any) => `${item.model.provider}/${item.model.id}` === modelLabel);
					if (!entry) return;
					selected = { provider: entry.model.provider, modelId: entry.model.id, thinkingLevel: entry.thinkingLevel };
					const mode = await loadModeSpec(ctx.cwd, "advisor");
					const defaultThinking = selected.thinkingLevel ?? sessionState.thinkingLevel ?? mode?.thinkingLevel ?? DEFAULT_THINKING;
					const levels: AdvisorThinkingLevel[] = entry.model.reasoning ? [...ADVISOR_THINKING_LEVELS] : ["off"];
					const orderedLevels = levels.includes(defaultThinking as AdvisorThinkingLevel) ? [defaultThinking as AdvisorThinkingLevel, ...levels.filter((level) => level !== defaultThinking)] : levels;
					const thinkingLevel = await (ctx.ui as any).select(`Advisor thinking for ${modelLabel}`, orderedLevels);
					if (!thinkingLevel) return;
					selected.thinkingLevel = thinkingLevel as AdvisorThinkingLevel;
				} else {
					const parsed = parseAdvisorModelArgs(rawArg);
					if (!parsed) {
						ctx.ui.notify("usage: /advisor model provider/model [thinking] (or default)", "warning");
						return;
					}
					const model = ctx.modelRegistry.find(parsed.model.provider, parsed.model.modelId);
					if (!model) {
						ctx.ui.notify(`advisor model not found: ${parsed.model.provider}/${parsed.model.modelId}`, "warning");
						return;
					}
					selected = { ...parsed.model, ...(parsed.thinkingLevel ? { thinkingLevel: model.reasoning ? parsed.thinkingLevel : "off" } : {}) };
				}
				setSessionState({ ...sessionState, model: { provider: selected.provider, modelId: selected.modelId }, ...(selected.thinkingLevel ? { thinkingLevel: selected.thinkingLevel } : {}) });
				ctx.ui.notify(`advisor model set — ${selected.provider}/${selected.modelId}${selected.thinkingLevel ? ` (${selected.thinkingLevel})` : ""}; applies next turn`, "info");
				return;
			}

			// Hidden test hook. An idle nit delivers directly so it remains useful even
			// before the runtime's first review; running/high-severity cases use the queue.
			if (arg.startsWith("test")) {
				const parsed = parseAdvisorTestArgs(rawArg);
				if (!parsed) {
					ctx.ui.notify("usage: /advisor test <nit|concern|blocker> <note>", "warning");
					return;
				}
				if (parsed.severity === "nit" && turnState !== "running") sendNit(parsed.note, parsed.severity, turnState === "ended-terminal");
				else deliverAdvice(parsed.note, parsed.severity);
				return;
			}

			ctx.ui.notify("usage: /advisor [on|off|status|model]", "warning");
		},
	});
}

export default function advisorExtension(pi: ExtensionAPI, inheritedState: AdvisorSessionState = { enabled: false }): void {
	registerAdvisorWorkflowIntegration();
	installAdvisor(pi, inheritedState);
}
