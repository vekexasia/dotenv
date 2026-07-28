// Marks the pane blocked in herdr while an open-nvim.sh operator review is open.
// The script itself cannot report to herdr: pane state is owned by the
// herdr:pi hook authority, and reporting under that source from outside
// breaks the integration's sequence counter.
//
// The blocked STATE comes from the herdr:blocked event (herdr-agent-state.ts).
// Its `label` is only used as report_agent's `message`, which herdr stores but
// never renders; the sidebar text comes from state_labels metadata, so the
// visible label needs a separate report-metadata call from a user: source.
import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LABEL = "wait nvim";
const METADATA_SOURCE = "user:opennvim";

export const isOpenNvim = (toolName: string, command: unknown): boolean =>
  toolName === "bash" && typeof command === "string" && command.includes("open-nvim.sh");

const label = (args: string[]) => {
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) return;
  execFile("herdr", ["pane", "report-metadata", pane, "--source", METADATA_SOURCE, ...args], () => {});
};

export default function (pi: ExtensionAPI) {
  if (process.env.HERDR_ENV !== "1") return;

  const pending = new Set<string>();

  pi.on("tool_execution_start", (event) => {
    if (!isOpenNvim(event.toolName, (event.args as { command?: unknown })?.command)) return;
    pending.add(event.toolCallId);
    pi.events.emit("herdr:blocked", { active: true, label: LABEL });
    label(["--state-label", `blocked=${LABEL}`]);
  });

  pi.on("tool_execution_end", (event) => {
    if (!pending.delete(event.toolCallId)) return;
    pi.events.emit("herdr:blocked", { active: false });
    label(["--clear-state-labels"]);
  });
}
