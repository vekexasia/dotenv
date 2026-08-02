/** Advice domain, delivery policy, and session-state helpers. */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

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
export const rankOf = (s: AdvisorSeverity | undefined): number => SEVERITY_RANK[s ?? "nit"];
export const dedupeKey = (note: string): string => note.trim().replace(/\s+/g, " ");
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

export function copyAdvisorSessionState(state: AdvisorSessionState): AdvisorSessionState {
	return {
		enabled: state.enabled,
		...(state.model ? { model: { ...state.model } } : {}),
		...(state.thinkingLevel ? { thinkingLevel: state.thinkingLevel } : {}),
	};
}

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
