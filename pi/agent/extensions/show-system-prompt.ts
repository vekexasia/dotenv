import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";

const EXACT_PATH = "/tmp/exact-model-request.json";

export default function (pi: ExtensionAPI) {
  // Fires with the exact payload sent to the model, after all
  // before_agent_start hooks (so it includes PONYTAIL MODE ACTIVE).
  pi.on("before_provider_request", async (event) => {
    await writeFile(EXACT_PATH, JSON.stringify(event.payload, null, 2), "utf8");
  });

  pi.registerCommand("exact-prompt", {
    description:
      "Show the exact request payload sent to the model (hook-captured) at /tmp/exact-model-request.json",
    handler: async (_args, ctx) => {
      try {
        await readFile(EXACT_PATH, "utf8");
        ctx.ui.notify(`Exact model request at ${EXACT_PATH}`);
      } catch {
        ctx.ui.notify(
          "No request captured yet. Send a prompt first, then run /exact-prompt.",
          "warn",
        );
      }
    },
  });
}
