import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("system-prompt", {
    description: "Dump the current system prompt to /tmp/system-prompt.md",
    handler: async (_args, ctx) => {
      const path = "/tmp/system-prompt.md";
      await writeFile(path, ctx.getSystemPrompt(), "utf8");
      ctx.ui.notify(`System prompt written to ${path}`, "info");
    },
  });
}
