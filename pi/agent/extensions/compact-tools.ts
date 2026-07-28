// tested
/**
 * Compact rendering for read and edit tools.
 *
 * pi-hashline-edit owns those tools but defines no custom renderer,
 * so Pi falls back to the verbose built-in. We monkey-patch
 * ToolExecutionComponent.prototype.updateDisplay to intercept those
 * two tools and render a single compact line instead.
 *
 * When expanded (ctrl+o) the original updateDisplay runs normally.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { realpathSync } from "fs";
import { createRequire } from "module";
import { homedir } from "os";

const PATCH_FLAG = "__compactToolsPatched" as const;

function shortenPath(p: string): string {
	const home = homedir();
	return p?.startsWith(home) ? `~${p.slice(home.length)}` : (p ?? "");
}

type Themed = { fg(color: string, text: string): string; bold(text: string): string; bg(color: string, text: string): string };

type PatchableProto = typeof ToolExecutionComponent.prototype & {
	[PATCH_FLAG]?: boolean;
	toolName: string;
	args: Record<string, unknown>;
	expanded: boolean;
	result?: { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
	isPartial: boolean;
	showImages: boolean;
	imageWidthCells: number;
	imageComponents: unknown[];
	imageSpacers: unknown[];
	convertedImages: Map<number, { data: string; mimeType: string }>;
	addChild(c: unknown): void;
	removeChild(c: unknown): void;
	contentText: { setText(s: string): void; setCustomBgFn(fn: (s: string) => string): void };
	contentBox: { clear(): void; addChild(c: unknown): void; setBgFn(fn: (s: string) => string): void };
	hideComponent: boolean;
	hasRendererDefinition(): boolean;
	getRenderShell(): string;
	__originalUpdateDisplay?(): void;
};

const COMPACT_TOOLS = new Set(["read", "edit", "write", "bash"]);

// By default bash shows full output when Ctrl+O expanded (original behaviour).
// Set PI_COMPACT_BASH=1 or COMPACT_BASH=1 to keep bash compact even when expanded.
const BASH_ALWAYS_COMPACT = process.env.PI_COMPACT_BASH === "1" || process.env.COMPACT_BASH === "1";

const SENSITIVE_FLAG_RE = /(--?(?:api[-_]?key|token|secret|password|passwd|pwd|auth|authorization|access[-_]?token|refresh[-_]?token)(?:\s+|=))([^\s'"`]+)/gi;
const SENSITIVE_ASSIGNMENT_RE = /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|AUTH|CREDENTIAL|PRIVATE[_-]?KEY)[A-Z0-9_]*\s*=\s*)([^\s'"`]+)/gi;
const BEARER_RE = /\b(Bearer\s+)([A-Za-z0-9._~+\/-]+=*)/gi;
const COMMON_SECRET_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16})\b/g;

function redactSensitive(text: string): string {
	return text
		.replace(SENSITIVE_ASSIGNMENT_RE, "$1[redacted]")
		.replace(SENSITIVE_FLAG_RE, "$1[redacted]")
		.replace(BEARER_RE, "$1[redacted]")
		.replace(COMMON_SECRET_RE, "[redacted]");
}

function truncateSingleLine(text: string, max = 96): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function extractTextOutput(result: PatchableProto["result"]): string {
	return result?.content
		.filter((entry) => entry.type === "text" && typeof entry.text === "string")
		.map((entry) => entry.text)
		.join("\n") ?? "";
}

function buildCompactLabel(toolName: string, args: Record<string, unknown>, t: Themed): string {
	if (toolName === "read") {
		const path = t.fg("accent", shortenPath(args.path as string));
		let suffix = "";
		if (args.offset !== undefined || args.limit !== undefined) {
			const start = (args.offset as number) ?? 1;
			const end = args.limit !== undefined ? start + (args.limit as number) - 1 : "";
			suffix = `:${start}${end !== "" ? `-${end}` : ""}`;
		}
		return `${t.fg("toolTitle", t.bold("read"))} ${path}${suffix}`;
	}
	if (toolName === "edit" || toolName === "write") {
		const path = t.fg("accent", shortenPath(args.path as string));
		return `${t.fg("toolTitle", t.bold(toolName))} ${path}`;
	}
	if (toolName === "bash") {
		const command = typeof args.command === "string" ? args.command : "";
		const lineCount = command.split("\n").length;
		const summary = lineCount > 1
			? `${lineCount} lines`
			: truncateSingleLine(redactSensitive(command)) || "command";
		return `${t.fg("toolTitle", t.bold("bash"))} ${t.fg("accent", summary)}`;
	}
	return t.fg("toolTitle", t.bold(toolName));
}

function buildExpandedBashText(args: Record<string, unknown>, result: PatchableProto["result"], t: Themed): string {
	const command = redactSensitive(typeof args.command === "string" ? args.command : "");
	const output = redactSensitive(extractTextOutput(result));
	const sections = [t.fg("toolTitle", t.bold("bash"))];
	if (command) sections.push(t.fg("muted", `$ ${command}`));
	if (output) sections.push(t.fg("toolOutput", output));
	return sections.join("\n\n");
}

const piAgentDistIndex = realpathSync(process.argv[1]?.startsWith("/$bunfs/") ? process.execPath : (process.argv[1] ?? process.execPath));

let _theme: Themed | undefined;
function getTheme(): Themed {
	if (!_theme) {
		const req = createRequire(piAgentDistIndex);
		_theme = req("./modes/interactive/theme/theme.js").theme as Themed;
	}
	return _theme!;
}

type PatchStatus = "applied" | "already-patched" | "missing-update-display";

function isPatchActive(): boolean {
	const proto = ToolExecutionComponent.prototype as PatchableProto;
	return proto[PATCH_FLAG] === true && typeof proto.__originalUpdateDisplay === "function";
}

function formatStatusMessage(lastStatus: PatchStatus): string {
	const proto = ToolExecutionComponent.prototype as PatchableProto;
	return [
		`compact-tools: ${isPatchActive() ? "active" : "inactive"}`,
		`last load: ${lastStatus}`,
		`patch flag: ${proto[PATCH_FLAG] === true ? "yes" : "no"}`,
		`original updateDisplay: ${typeof proto.__originalUpdateDisplay === "function" ? "yes" : "no"}`,
		`tools: ${Array.from(COMPACT_TOOLS).join(", ")}`,
		`note: Ctrl+O on bash shows full output by default; set PI_COMPACT_BASH=1 to keep it compact`,
	].join("\n");
}

function applyPatch(): PatchStatus {
	const proto = ToolExecutionComponent.prototype as PatchableProto;
	if (proto[PATCH_FLAG]) return "already-patched";

	const original = proto.updateDisplay;
	if (typeof original !== "function") return "missing-update-display";

	proto.__originalUpdateDisplay = original;
	proto.updateDisplay = function patchedUpdateDisplay(this: PatchableProto) {
		if (!COMPACT_TOOLS.has(this.toolName) || (this.expanded && this.toolName !== "bash")) {
			original.call(this);
			return;
		}

		const t = getTheme();
		const bgFn = this.isPartial
			? (s: string) => t.bg("toolPendingBg", s)
			: this.result?.isError
				? (s: string) => t.bg("toolErrorBg", s)
				: (s: string) => t.bg("toolSuccessBg", s);

		this.hideComponent = false;

		if (this.hasRendererDefinition() && this.getRenderShell() !== "self") {
			this.contentBox.setBgFn(bgFn);
			this.contentBox.clear();
			this.contentBox.addChild(new Text(!BASH_ALWAYS_COMPACT && this.expanded && this.toolName === "bash" ? buildExpandedBashText(this.args, this.result, t) : buildCompactLabel(this.toolName, this.args, t), 0, 0));
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(!BASH_ALWAYS_COMPACT && this.expanded && this.toolName === "bash" ? buildExpandedBashText(this.args, this.result, t) : buildCompactLabel(this.toolName, this.args, t));
		}

		// Rebuild image children (same logic as original updateDisplay)
		for (const img of this.imageComponents) this.removeChild(img);
		this.imageComponents = [];
		for (const sp of this.imageSpacers) this.removeChild(sp);
		this.imageSpacers = [];

		if (this.result) {
			const piTuiPath = createRequire(piAgentDistIndex).resolve("@earendil-works/pi-tui/dist/index.js");
			const { getCapabilities, Image, Spacer } = createRequire(piTuiPath)(piTuiPath);
			const caps = getCapabilities();
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;
					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData, imageMimeType,
						{ fallbackColor: (s: string) => t.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}
	};

	proto[PATCH_FLAG] = true;
	return "applied";
}

export default function compactToolsExtension(pi: ExtensionAPI) {
	const disabled = process.env.PI_DISABLE_COMPACT_TOOLS !== "0";
	if (disabled) {
		// Temporarily disabled while debugging inline image truncation in WezTerm/Kitty rendering.
		return;
	}
	const patchStatus = applyPatch();

	pi.registerCommand("compact-tools-status", {
		description: "Show compact-tools renderer patch status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatStatusMessage(patchStatus), isPatchActive() ? "info" : "warning");
		},
	});

	if (patchStatus === "missing-update-display") {
		let warned = false;
		pi.on("session_start", async (_event, ctx) => {
			if (warned || !ctx.hasUI) return;
			warned = true;
			ctx.ui.notify("compact-tools: failed to patch ToolExecutionComponent", "warning");
		});
	}
}
