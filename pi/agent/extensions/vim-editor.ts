import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

const SEPARATOR = "===== EDIT BELOW THIS LINE =====\n";

export default function (pi: ExtensionAPI) {
  pi.registerShortcut(Key.alt("m"), {
    description: "Edit prompt in nvim with last message context",
    handler: async (ctx) => {
      await editPromptInNvim(ctx);
    },
  });
}

async function editPromptInNvim(ctx: ExtensionContext) {
  try {
    // Get last assistant message from session history
    const entries = ctx.sessionManager.getEntries();
    let lastMessage = "";

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as {
        type: string;
        message?: { role?: string; content?: unknown };
      };
      if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
      const content = entry.message.content;
      if (typeof content === "string") {
        lastMessage = content;
      } else if (Array.isArray(content)) {
        lastMessage = content
          .filter((c: { type?: string }) => c?.type === "text")
          .map((c: { text?: string }) => c.text ?? "")
          .join("\n");
      }
      if (lastMessage) break;
    }

    // Create temp file with last message + separator + current input
    const currentInput = ctx.ui.getEditorText();
    const tempFile = join(tmpdir(), `pi-prompt-${Date.now()}.md`);
    const content = lastMessage ? `${lastMessage}\n\n${SEPARATOR}${currentInput}` : `${SEPARATOR}${currentInput}`;

    writeFileSync(tempFile, content);


    // Open in nvim at end of file
    spawnSync("nvim", ["+", tempFile], { stdio: "inherit" });

    // Read edited content
    const edited = readFileSync(tempFile, "utf-8");

    // Extract prompt (everything after separator)
    const parts = edited.split(SEPARATOR);
    if (parts.length < 2) {
      ctx.ui.notify("No prompt entered", "warning");
      unlinkSync(tempFile);
      return;
    }

    const prompt = parts.slice(1).join(SEPARATOR).trim();

    if (!prompt) {
      ctx.ui.notify("No prompt entered", "warning");
      unlinkSync(tempFile);
      return;
    }

    // Put prompt into pi's editor (no auto-send)
    ctx.ui.setEditorText(prompt);

    // Clean up
    unlinkSync(tempFile);
  } catch (err) {
    ctx.ui.notify(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}
