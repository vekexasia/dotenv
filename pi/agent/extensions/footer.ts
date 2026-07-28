import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type Theme = ExtensionContext["ui"]["theme"];

const ASK_TOOL_NAMES = ["questionnaire"];
const SEARCH_TOOL_NAMES = ["web_search", "fetch_content", "get_search_content", "search", "web-search"];

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function sanitize(text: string): string {
	return stripAnsi(text)
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function formatWindowTokens(count: number): string {
	if (!count) return "";
	if (count < 1000) return `${count}`;
	if (count < 1000000) return `${Math.round(count / 1000)}K`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatModelLabel(modelId?: string): string {
	if (!modelId) return "No model";

	const claudeMatch = modelId.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)$/i);
	if (claudeMatch) {
		const family = claudeMatch[1]!.charAt(0).toUpperCase() + claudeMatch[1]!.slice(1).toLowerCase();
		return `${family} ${claudeMatch[2]}.${claudeMatch[3]}`;
	}

	const gptMatch = modelId.match(/^gpt-(\d+)(?:\.(\d+))?$/i);
	if (gptMatch) {
		return `GPT ${gptMatch[1]}${gptMatch[2] ? `.${gptMatch[2]}` : ""}`;
	}

	return modelId
		.replace(/^claude-/i, "")
		.replace(/^gpt-/i, "GPT ")
		.split(/[-_]/)
		.map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
		.join(" ");
}

function colorPercent(theme: Theme, percent: number | null | undefined): string {
	if (percent === null || percent === undefined) return theme.fg("muted", "?");
	const rounded = Math.round(percent);
	if (percent >= 90) return theme.fg("error", `${rounded}%`);
	if (percent >= 70) return theme.fg("warning", `${rounded}%`);
	return theme.fg("muted", `${rounded}%`);
}

function buildThinkingDots(pi: ExtensionAPI, theme: Theme): string {
	const levels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
	let level: string = "off";
	try {
		level = pi.getThinkingLevel();
	} catch {}

	const filled = Math.max(0, levels.indexOf(level as (typeof levels)[number]));
	const color = level === "xhigh"
		? "error"
		: level === "high"
			? "warning"
			: level === "medium"
				? "accent"
				: "text";
	return theme.fg(color, "▪".repeat(filled)) + theme.fg("dim", "▫".repeat(5 - filled));
}

function joinSides(left: string, right: string, width: number, ellipsis: string): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (leftWidth + rightWidth <= width) {
		return left + " ".repeat(width - leftWidth - rightWidth) + right;
	}

	const minRight = Math.min(rightWidth, Math.max(14, Math.floor(width * 0.35)));
	const maxLeft = Math.max(0, Math.min(width, width - minRight - 1));
	const truncatedLeft = truncateToWidth(left, maxLeft, ellipsis);
	const truncatedLeftWidth = visibleWidth(truncatedLeft);
	const remaining = Math.max(0, width - truncatedLeftWidth);
	if (remaining === 0) return truncatedLeft;

	const truncatedRight = truncateToWidth(right, remaining, ellipsis);
	const truncatedRightWidth = visibleWidth(truncatedRight);
	const padding = Math.max(0, width - truncatedLeftWidth - truncatedRightWidth);
	return truncatedLeft + " ".repeat(padding) + truncatedRight;
}

function hasAny(activeTools: Set<string>, names: string[]): boolean {
	return names.some((name) => activeTools.has(name));
}

function getActiveToolSet(pi: ExtensionAPI): Set<string> {
	try {
		return new Set(pi.getActiveTools().map((name) => name.toLowerCase()));
	} catch {
		return new Set();
	}
}

function getAvailableToolSet(pi: ExtensionAPI): Set<string> {
	try {
		return new Set(pi.getAllTools().map((tool) => tool.name.toLowerCase()));
	} catch {
		return new Set();
	}
}

function flag(theme: Theme, enabled: boolean, char: string, color: "success" | "accent" | "warning" | "muted"): string {
	return enabled ? theme.fg(color, char) : theme.fg("dim", char);
}

function accessFlags(theme: Theme, activeTools: Set<string>): string {
	const canRead = activeTools.has("read");
	const canWrite = activeTools.has("write") || activeTools.has("edit");
	const canExec = activeTools.has("bash");
	return [
		flag(theme, canRead, "r", "success"),
		flag(theme, canWrite, "w", "accent"),
		flag(theme, canExec, "x", "warning"),
	].join("");
}

function capabilityFlags(theme: Theme, availableTools: Set<string>): string {
	const canAsk = hasAny(availableTools, ASK_TOOL_NAMES);
	const canSearch = hasAny(availableTools, SEARCH_TOOL_NAMES);
	return [
		flag(theme, canAsk, "q", "accent"),
		flag(theme, canSearch, "s", "accent"),
	].join("");
}

function getWorkspaceLabel(ctx: ExtensionContext): string {
	const sessionName = sanitize(ctx.sessionManager.getSessionName() ?? "");
	if (sessionName) return sessionName;
	const base = sanitize(path.basename(ctx.cwd).replace(/^\.+/, ""));
	return base || "pi";
}

function getStatusLabel(footerData: { getExtensionStatuses(): ReadonlyMap<string, string> }, key: string): string | undefined {
	const value = footerData.getExtensionStatuses().get(key);
	if (!value) return undefined;
	const label = sanitize(value);
	return label || undefined;
}

function applyFooter(pi: ExtensionAPI, ctx: ExtensionContext, notifyState: { active: boolean; blinkOn: boolean }): void {
	if (!ctx.hasUI) return;
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsub = footerData.onBranchChange(() => tui.requestRender());

		let blinkTimer: ReturnType<typeof setInterval> | null = null;

		function startBlink(): void {
			if (blinkTimer) return;
			notifyState.blinkOn = true;
			blinkTimer = setInterval(() => {
				notifyState.blinkOn = !notifyState.blinkOn;
				tui.requestRender();
			}, 600);
		}

		function stopBlink(): void {
			if (blinkTimer) {
				clearInterval(blinkTimer);
				blinkTimer = null;
			}
			notifyState.blinkOn = false;
		}

		function dismissOnKeypress(): void {
			const onData = (data: Buffer) => {
				const str = data.toString();
				// Ignore terminal focus reporting sequences (\e[I / \e[O)
				if (str.includes("\x1b[I") || str.includes("\x1b[O")) {
					process.stdin.once("data", onData);
					return;
				}
				notifyState.active = false;
				stopBlink();
				tui.requestRender();
			};
			process.stdin.once("data", onData);
		}

		const unsubFired = pi.events.on("pi-notify:fired", () => {
			notifyState.active = true;
			startBlink();
			dismissOnKeypress();
			tui.requestRender();
		});

		notifyState.stopBlink = stopBlink;

		// Restore blink if already active (e.g. after session switch)
		if (notifyState.active) startBlink();

		return {
			dispose() {
				stopBlink();
				unsub();
				unsubFired();
			},
			invalidate() {},
			render(width: number): string[] {
				const usage = ctx.getContextUsage();
				const percent = usage?.percent ?? null;
				const windowTokens = formatWindowTokens(usage?.contextWindow ?? ctx.model?.contextWindow ?? 0);
				const branch = footerData.getGitBranch() || "nogit";
				const workspace = getWorkspaceLabel(ctx);
				const modeLabel = getStatusLabel(footerData, "mode");
				const agentLabel = getStatusLabel(footerData, "agent");
				const model = formatModelLabel(ctx.model?.id);
				const activeTools = getActiveToolSet(pi);
				const availableTools = getAvailableToolSet(pi);

				const bell = notifyState.active && notifyState.blinkOn ? ` ${theme.fg("warning", "🔔")}` : "";

				const left = [
					theme.fg("dim", "⟪ "),
					theme.fg("muted", branch),
					" ",
					theme.fg("accent", workspace),
					modeLabel ? ` ${theme.fg("warning", modeLabel)}` : "",
					!modeLabel && agentLabel ? ` ${theme.fg("accent", agentLabel)}` : "",
					theme.fg("dim", " @ "),
					colorPercent(theme, percent),
					theme.fg("dim", " / "),
					accessFlags(theme, activeTools),
					" ",
					capabilityFlags(theme, availableTools),
					bell,
					theme.fg("dim", " ⟫"),
				].join("");

				const right = [
					theme.fg("dim", "⟪ "),
					theme.bold(model),
					" ",
					buildThinkingDots(pi, theme),
					windowTokens ? theme.fg("muted", ` ${windowTokens}`) : "",
					theme.fg("dim", " ⟫"),
				].join("");

				return [joinSides(left, right, width, theme.fg("dim", "…"))];
			},
		};
	});
}

export default function registerFooterExtension(pi: ExtensionAPI): void {
	const notifyState = { active: false, blinkOn: false, stopBlink: (() => {}) as () => void };

	pi.on("agent_start", (_event, ctx) => {
		notifyState.active = false;
		notifyState.blinkOn = false;
		notifyState.stopBlink();
		applyFooter(pi, ctx, notifyState);
	});

	pi.on("session_start", (_event, ctx) => applyFooter(pi, ctx, notifyState));
	pi.on("session_switch", (_event, ctx) => applyFooter(pi, ctx, notifyState));
	pi.on("session_branch", (_event, ctx) => applyFooter(pi, ctx, notifyState));
	pi.on("model_select", (_event, ctx) => applyFooter(pi, ctx, notifyState));
}
