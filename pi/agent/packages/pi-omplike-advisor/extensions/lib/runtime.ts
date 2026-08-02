/** Persistent advisor agent and its serialized review runtime. */

import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { convertToLlm, createReadOnlyTools } from "@earendil-works/pi-coding-agent";

import {
	AdviseTool,
	dedupeKey,
	formatReconfirmPreamble,
	isHighSeverity,
	rankOf,
	type AdvisorNote,
	type AdvisorSeverity,
} from "./advisor-core.js";
import { buildReviewMessages } from "./transcript.js";

// ---- build the persistent advisor Agent ----

export function buildAdvisorAgent(opts: {
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
