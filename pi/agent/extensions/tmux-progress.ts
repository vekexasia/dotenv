// Shows agent progress in the tmux tab via a per-window user option
// (@pi_status) that ~/.tmux.conf references. Never touches the window name.
//
// Subagents (incl. background ones) run in-process with their own extension
// binding but SHARED module scope, so a module-level refcount keeps the
// spinner alive while any agent (parent or subagent) is working. The tui flag
// ensures headless runs (print/rpc/json without a tui parent) stay silent.
//
// Requires in ~/.tmux.conf (not managed by this repo):
//   set -g focus-events on
//   set -g window-status-format         " #I #W#{?#{@pi_status}, #{@pi_status},} "
//   set -g window-status-current-format " #I #W#{?#{@pi_status}, #{@pi_status},} "
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";

const pane = process.env.TMUX_PANE;
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let timer: ReturnType<typeof setInterval> | undefined;
// tmux calls are separate processes: without serialization a spinner-frame
// set-option can land AFTER the clearing unset and leak a stale frame.
let q: Promise<unknown> = Promise.resolve();
function tmux(args: string[]): void {
    q = q.then(() => new Promise((res) => execFile("tmux", args, res)));
}

function setStatus(text: string): void {
    if (!pane) return; // ponytail: not in tmux, no-op
    tmux(["set-option", "-w", "-t", pane, "@pi_status", text]);
    tmux(["refresh-client", "-S"]); // force status redraw now
}

function clearStatus(): void {
    if (!pane) return;
    if (timer) { clearInterval(timer); timer = undefined; }
    tmux(["set-option", "-wu", "-t", pane, "@pi_status"]);
    tmux(["refresh-client", "-S"]);
}

function startSpinner(): void {
    if (!pane || timer) return;
    let i = 0;
    setStatus(frames[0]);
    timer = setInterval(() => { i = (i + 1) % frames.length; setStatus(frames[i]); }, 120);
}

let active = 0;
let tui = false; // set once the interactive parent session is seen

export default function (pi: ExtensionAPI) {
    pi.on("agent_start", async (_e, ctx) => {
        if (ctx.mode === "tui") tui = true;
        active++;
        if (tui) startSpinner();
    });
    pi.on("agent_end", async () => {
        active = Math.max(0, active - 1);
        if (active === 0) clearStatus();
    });
    // ponytail: no session_shutdown safety net; a killed subagent still emits agent_end
}
