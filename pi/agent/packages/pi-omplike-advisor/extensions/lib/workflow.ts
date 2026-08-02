/** Optional workflow inheritance and the serialized advisor bridge. */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { copyAdvisorSessionState } from "./advisor-core.js";
import type { AdvisorSessionState } from "./advisor-core.js";

export type WorkflowCore = { registerWorkflowExtension?: (extension: unknown) => void };
type WorkflowUtils = { disabledResources?: (patterns: readonly string[], resources: readonly string[]) => string[] };
export type AdvisorBridgeSpec = { advisorPath: string; jitiPath: string; aliases: Readonly<Record<string, string>> };
export type AdvisorExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
type WorkflowAdvisorState = {
 sessions: Map<string, AdvisorSessionState>;
 runs: Map<string, { sessionId: string; state: AdvisorSessionState }>;
};
const WORKFLOW_ADVISOR_STATE_KEY = Symbol.for("pi-omplike-advisor.workflow-state");
const workflowAdvisorState = ((globalThis as any)[WORKFLOW_ADVISOR_STATE_KEY] ??= { sessions: new Map(), runs: new Map() }) as WorkflowAdvisorState;
export const workflowSessionStates = workflowAdvisorState.sessions;
export const workflowRunStates = workflowAdvisorState.runs;
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

export function resolveAdvisorBridgeSpec(advisorPath: string, entrypoint = process.argv[1]): AdvisorBridgeSpec | undefined {
	const root = runtimePackageRoot(entrypoint);
	if (!root) return undefined;
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
export function advisorResourceAllowed(advisorPath: string, patterns: readonly string[]): boolean {
	if (!patterns.length) return true;
	const disabledResources = loadWorkflowUtils()?.disabledResources;
	if (typeof disabledResources !== "function") return false;
	return disabledResources(patterns, [advisorPath]).length === 0;
}

export function createAdvisorBridgeFactory(state: AdvisorSessionState, spec: AdvisorBridgeSpec | undefined): AdvisorExtensionFactory | undefined {
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

export function registerAdvisorWorkflowIntegration(advisorPath: string, load: (() => WorkflowCore | undefined) | undefined = loadWorkflowCore): boolean {
	if (workflowIntegrationRegistered) return true;
	const core = load?.();
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
						const spec = resolveAdvisorBridgeSpec(advisorPath, process.argv[1]);
						if (!spec) throw new Error("Advisor workflow bridge requires the originating Node Pi runtime");
						if (!advisorResourceAllowed(spec.advisorPath, agent.sessionInput.resourcePolicy?.effective?.extensions ?? [])) return;
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
