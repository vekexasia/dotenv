import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let offersMade = 0;
	let pendingOffer = false;

	pi.on("session_start", () => {
		offersMade = 0;
		pendingOffer = false;
	});

	pi.on("tool_result", (event) => {
		if (offersMade >= 2) return;
		if (event.toolName !== "bash") return;
		const cmd = (event.input as Record<string, unknown> | undefined)?.command;
		if (typeof cmd !== "string") return;
		if (!/\bgit\s+commit\b/.test(cmd)) return;
		pendingOffer = true;
	});

	pi.on("before_agent_start", () => {
		if (!pendingOffer || offersMade >= 2) return;
		pendingOffer = false;
		offersMade++;

		return {
			message: {
				customType: "learning-opportunities-auto",
				content:
					"[learning-opportunities-auto] The user just committed code. " +
					"Per the learning-opportunities skill, consider whether this is a good moment " +
					"to offer a learning exercise. If the committed work involved new files, " +
					"schema changes, architectural decisions, refactors, or unfamiliar patterns, " +
					"ask the user (one short sentence) if they'd like a 10-15 minute exercise. " +
					"Do not start the exercise until they confirm. " +
					"If they decline, note it — no more offers this session.",
				display: false,
			},
		};
	});
}
