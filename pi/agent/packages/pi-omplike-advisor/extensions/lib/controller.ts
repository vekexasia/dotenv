/** Pi lifecycle adapter for the advisor runtime. */

import * as fs from "node:fs";
import * as path from "node:path";

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Theme, type TUI } from "@earendil-works/pi-tui";

import {
	ADVISOR_STATE_TYPE,
	ADVISOR_THINKING_LEVELS,
	AdviseTool,
	advisorRuntimeChangePolicy,
	copyAdvisorSessionState,
	formatAdvisoryContent,
	isHighSeverity,
	isTerminalTurn,
	parseAdvisorModelArgs,
	parseAdvisorTestArgs,
	readAdvisorSessionState,
	runTurnBlock,
} from "./advisor-core.js";
import type {
	AdvisorNote,
	AdvisorSessionState,
	AdvisorSeverity,
	AdvisorThinkingLevel,
	PrimaryTurnState,
} from "./advisor-core.js";
import { AdvisorModelPicker, type AdvisorModelPickerItem } from "./model-ui.js";
import { AdvisorRuntime, buildAdvisorAgent } from "./runtime.js";
import { formatTurnDelta } from "./transcript.js";
import { loadModeSpec } from "./mode-utils.js";
import { workflowRunStates, workflowSessionStates } from "./workflow.js";

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
const REVIEW_LOG_PATH = "/tmp/pi-omplike-advisor-reviews.jsonl";
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

function loadSystemPrompt(cwd: string, advisorPath: string): string {
	let prompt = fs.readFileSync(path.resolve(path.dirname(advisorPath), "../../../advisor-system.md"), "utf8").trim();
	// Append WATCHDOG.md (advisor-only project guidance) if present in cwd.
	try {
		const wd = fs.readFileSync(path.join(cwd, "WATCHDOG.md"), "utf8").trim();
		if (wd) prompt += `\n\nEspecially pay attention to:\n<attention>\n${wd}\n</attention>`;
	} catch {}
	return prompt;
}

export function installAdvisor(pi: ExtensionAPI, inheritedState: AdvisorSessionState = { enabled: false }, advisorPath: string): void {
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
	function appendReviewLog(event: Record<string, unknown>, sessionId = activeSessionId || null): void {
		try {
			fs.appendFileSync(REVIEW_LOG_PATH, `${JSON.stringify({
				timestamp: new Date().toISOString(),
				pid: process.pid,
				sessionId,
				...event,
			})}\n`, "utf8");
		} catch (error) {
			dbg("review log failed", error instanceof Error ? error.message : String(error));
		}
	}
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
		appendReviewLog({ event: "advice_injected", severity: severity ?? "nit", noteChars: note.length });
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
			appendReviewLog({ event: "advice_injected", severity: n.severity ?? "nit", noteChars: n.note.length });
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
			systemPrompt: loadSystemPrompt(ctx.cwd, advisorPath),
			modelRegistry: ctx.modelRegistry,
			adviseTool: builtAdviseTool,
		});
		// ADVISOR_COMPACT_AT: % of the advisor's context window at which it self-
		// compacts (clamped 50..95; default 80).
		const compactAt = Math.min(95, Math.max(50, Number(process.env.ADVISOR_COMPACT_AT) || 80));
		const reviewSessionIds = new Map<number, string | null>();
		builtRuntime = new AdvisorRuntime(agent, builtAdviseTool, 1000, dbg, compactAt, (outcome) => {
			// A disposed/replaced runtime may settle late; never let it flush the new one.

			if (runtime === builtRuntime) {
				flushSettledAdvice(outcome);
				if (runtime === builtRuntime && pendingRuntimeRebuild && builtRuntime.idle && !turnRunning) retireRuntimeForRebuild();
			}
		},
		(event) => {
			if (event.phase === "started") reviewSessionIds.set(event.reviewNumber, activeSessionId || null);
			const sessionId = reviewSessionIds.get(event.reviewNumber) ?? (activeSessionId || null);
			appendReviewLog({
				event: `review_${event.phase}`,
				reviewNumber: event.reviewNumber,
				batchTurns: event.batchTurns,
				promptChars: event.promptChars,
				attempt: event.attempt,
				model: activeModelLabel ?? null,
				...(event.outcome ? { outcome: event.outcome } : {}),
				...(event.stopReason ? { stopReason: event.stopReason } : {}),
			}, sessionId);
			if (event.phase === "finished") reviewSessionIds.delete(event.reviewNumber);
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
		appendReviewLog({ event: "session_start", reason: event.reason, enabled });
	});

	// Tool-path handoff replaces the transcript without a session_start event
	// (low-level sessionManager.newSession()), so reset off this explicit signal.
	pi.events.on(HANDOFF_SESSION_REPLACED_CHANNEL, () => resetAdvisorState());
	pi.events.on("workflow:run-state-changed", (event: any) => {
		if (["completed", "failed", "stopped"].includes(event?.state)) workflowRunStates.delete(event.runId);
	});

	pi.on("session_shutdown", (event, ctx) => {
		appendReviewLog({ event: "session_shutdown", reason: event.reason });
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
