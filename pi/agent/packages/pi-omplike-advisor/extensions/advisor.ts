/**
 * /advisor — a persistent second model that reviews the main agent's work each
 * turn and injects concise advice inline.
 *
 * This file is intentionally only the stable Pi entrypoint. The policy, runtime,
 * transcript, UI, workflow, and lifecycle concerns live under ./lib/.
 */

import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { installAdvisor } from "./lib/controller.js";
import type { AdvisorSessionState } from "./lib/advisor-core.js";
import {
	createAdvisorBridgeFactory as createBridgeFactory,
	registerAdvisorWorkflowIntegration as registerWorkflowIntegration,
	resolveAdvisorBridgeSpec as resolveBridgeSpec,
	advisorResourceAllowed as isAdvisorResourceAllowed,
	type AdvisorBridgeSpec,
	type WorkflowCore,
} from "./lib/workflow.js";

export {
	ADVISOR_STATE_TYPE,
	ADVISOR_THINKING_LEVELS,
	AdviseTool,
	advisorRuntimeChangePolicy,
	formatAdvisoryContent,
	formatReconfirmPreamble,
	isHighSeverity,
	isTerminalTurn,
	nextBackoffMs,
	parseAdvisorModelArgs,
	parseAdvisorTestArgs,
	readAdvisorSessionState,
	runTurnBlock,
} from "./lib/advisor-core.js";
export type {
	AdvisorModelOverride,
	AdvisorNote,
	AdvisorSessionState,
	AdvisorSeverity,
	AdvisorThinkingLevel,
	PrimaryTurnState,
	TurnBlockRuntime,
} from "./lib/advisor-core.js";
export { filterAdvisorModels } from "./lib/model-ui.js";
export type { AdvisorModelSearchItem } from "./lib/model-ui.js";
export { formatTurnDelta, buildReviewMessages } from "./lib/transcript.js";
export { AdvisorRuntime } from "./lib/runtime.js";
export type { AdvisorBridgeSpec } from "./lib/workflow.js";

const ADVISOR_ENTRYPOINT = fileURLToPath(import.meta.url);

export function resolveAdvisorBridgeSpec(entrypoint = process.argv[1]): AdvisorBridgeSpec | undefined {
	return resolveBridgeSpec(ADVISOR_ENTRYPOINT, entrypoint);
}

export function advisorResourceAllowed(patterns: readonly string[], advisorPath = ADVISOR_ENTRYPOINT): boolean {
	return isAdvisorResourceAllowed(advisorPath, patterns);
}

export function createAdvisorBridgeFactory(state: AdvisorSessionState, spec = resolveAdvisorBridgeSpec()) {
	return createBridgeFactory(state, spec);
}

export function registerAdvisorWorkflowIntegration(load?: () => WorkflowCore | undefined): boolean {
	return registerWorkflowIntegration(ADVISOR_ENTRYPOINT, load);
}

export default function advisorExtension(pi: ExtensionAPI, inheritedState: AdvisorSessionState = { enabled: false }): void {
	registerWorkflowIntegration(ADVISOR_ENTRYPOINT, undefined);
	installAdvisor(pi, inheritedState, ADVISOR_ENTRYPOINT);
}
