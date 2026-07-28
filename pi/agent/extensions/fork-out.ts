import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

// /fork-out: copy the current root->leaf path into a NEW session file at this
// exact leaf, then open it in a new herdr horizontal split.
// The original instance is left completely untouched (no leaf move, no switch).

export default function (pi: ExtensionAPI) {
  pi.registerCommand("fork-out", {
    description: "Fork current leaf into a new pi instance in a herdr pane",
    handler: async (_args, ctx) => {
      const sm = ctx.sessionManager;

      const sourceFile = sm.getSessionFile();
      if (!sourceFile) return;

      const leafId = sm.getLeafId();
      if (!leafId) return;

      // Leaf-precise path, read-only. Does NOT move our leaf.
      const path = sm.getBranch(leafId);
      if (path.length === 0) return;

      const herdrPaneId = process.env.HERDR_PANE_ID;
      if (process.env.HERDR_ENV !== "1" || !herdrPaneId) return;

      const cwd = sm.getCwd();
      const header = sm.getHeader();
      const version = header?.version ?? 3;

      const newId = randomUUID();
      const timestamp = new Date().toISOString();
      const fileTimestamp = timestamp.replace(/[:.]/g, "-");
      const newFile = join(dirname(sourceFile), `${fileTimestamp}_${newId}.jsonl`);

      const newHeader = {
        type: "session",
        version,
        id: newId,
        timestamp,
        cwd,
        parentSession: sourceFile,
      };

      // Write header + the exact path entries (parentId chain preserved).
      writeFileSync(newFile, `${JSON.stringify(newHeader)}\n`, { flag: "wx" });
      for (const entry of path) {
        appendFileSync(newFile, `${JSON.stringify(entry)}\n`);
      }

      await spawnHerdrPane(cwd, newFile, herdrPaneId);
    },
  });
}

function run(cmd: string, cmdArgs: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, cmdArgs, { encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function spawnHerdrPane(cwd: string, sessionFile: string, paneId: string): Promise<void> {
  const split = await run("herdr", ["pane", "split", paneId, "--direction", "down"]);
  const newPane = JSON.parse(split)?.result?.pane?.pane_id;
  if (typeof newPane !== "string" || !newPane) throw new Error("herdr did not return a pane id");

  await run("herdr", ["pane", "run", newPane, `cd ${shq(cwd)} && pi --session ${shq(sessionFile)}; exec bash -l`]);
}
