import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// Live dashboard reporter: each pi session (including in-process subagents,
// which get their own extension binding) sends its state to a local dashboard server.

const URL = process.env.PI_LIVE_DASHBOARD_URL ?? "http://127.0.0.1:3939/snapshot";
const DIR = join(homedir(), ".pi");
const ENABLED_FILE = join(DIR, "live-dashboard.enabled");

function globallyEnabled(): boolean {
  try {
    return readFileSync(ENABLED_FILE, "utf8").trim() === "on";
  } catch {
    return false;
  }
}

interface ToolEntry {
  name: string;
  detail: string;
  status: "running" | "done" | "error";
  ts: number;
}

function toolDetail(name: string, args: any): string {
  if (!args) return "";
  const p = args.path ?? args.file_path ?? args.filePath;
  const detail = p ? String(p).replace(/^\/home\/[^/]+\//, "~/")
    : args.command || args.pattern || args.query || args.prompt || "";
  return String(detail).slice(0, 2000);
}

export default function (pi: ExtensionAPI) {
  // per-instance state: parent session and each subagent get their own copy
  const instanceId = randomUUID();
  const state = {
    pid: process.pid,
    instanceId,
    startedAt: 0,
    revision: 0,
    session: "",
    model: "",
    status: "idle" as "idle" | "working" | "closed",
    turns: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    // per-model breakdown for the stacked bar: model -> { cost, output }
    models: {} as Record<string, { cost: number; output: number }>,
    context: { tokens: 0, contextWindow: 0 },
    tools: [] as ToolEntry[],
    updatedAt: 0,
  };
  let enabled = globallyEnabled();
  let watching = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  function syncEnabled() {
    const next = globallyEnabled();
    const becameEnabled = next && !enabled;
    enabled = next;
    if (becameEnabled) flush();
  }

  function flush() {
    if (!enabled) return;
    state.updatedAt = Date.now();
    state.revision++;
    return fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state),
      signal: AbortSignal.timeout(2_000),
    }).catch(() => {});
  }

  pi.registerCommand("live-dashboard", {
    description: "Enable live-dashboard telemetry globally; use 'off' to disable",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action !== "" && action !== "on" && action !== "off") {
        ctx.ui.notify("Usage: /live-dashboard [on|off]", "warning");
        return;
      }
      mkdirSync(DIR, { recursive: true });
      writeFileSync(ENABLED_FILE, action === "off" ? "off\n" : "on\n");
      syncEnabled();
      ctx.ui.notify(`Live-dashboard telemetry ${enabled ? "enabled" : "disabled"} globally`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    state.startedAt = Date.now();
    state.session = basename(ctx.sessionManager.getCwd() || "pi");
    if (!watching) {
      watchFile(ENABLED_FILE, { interval: 500, persistent: false }, syncEnabled);
      watching = true;
    }
    syncEnabled();
    sniffAdvisorCost(ctx);
    void flush();
    heartbeat ??= setInterval(() => { void flush(); }, 10_000);
  });

  // The omplike advisor runs its own in-process Agent (direct provider stream,
  // no pi session), so its spend never reaches message_end. But it mirrors its
  // cumulative cost into the footer: setStatus("q-advisor", "| Advisor: $N.NN").
  // ctx.ui is one shared object across extensions: wrap setStatus and read the
  // number as it goes by. The wrapper is installed once and survives session
  // replacement (rebind can't unpatch it), so it routes through a mutable sink
  // on the ui object that each session_start repoints to the live instance.
  // NOTE: fragile by design, breaks if advisor changes its footer format;
  // acceptable vs patching third-party code.
  function sniffAdvisorCost(ctx: any) {
    // only the real interactive UI: subagent bindings have a no-op ui and must
    // not steal the sink (advisor deltas would land in the subagent's JSON)
    if (!ctx.hasUI) return;
    const ui = ctx.ui;
    if (!ui?.setStatus) return;
    // label advisor spend with its real model (modes.json "advisor" mode);
    // the footer only carries the cost, not the model
    let advisorModel = "advisor";
    try {
      const modes = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "modes.json"), "utf8"));
      advisorModel = modes.modes?.advisor?.modelId ?? advisorModel;
    } catch {}
    ui.__liveDashboardSink = (delta: number) => {
      state.usage.cost += delta;
      const mm = (state.models[advisorModel] ??= { cost: 0, output: 0 });
      mm.cost += delta;
      flush();
    };
    if (ui.__liveDashboardPatched) return;
    ui.__liveDashboardPatched = true;
    ui.__advisorSeen = 0; // last cumulative footer value
    const orig = ui.setStatus.bind(ui);
    ui.setStatus = (key: string, text: string | undefined) => {
      if (key === "q-advisor" && text) {
        const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
        const m = /Advisor:\s*\$([\d.]+)/.exec(plain);
        if (m) {
          const total = parseFloat(m[1]);
          if (total < ui.__advisorSeen) ui.__advisorSeen = total; // advisor runtime reset
          const delta = total - ui.__advisorSeen;
          if (delta > 0) {
            ui.__advisorSeen = total;
            ui.__liveDashboardSink?.(delta);
          }
        }
      }
      return orig(key, text);
    };
  }

  pi.on("session_shutdown", async () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    state.status = "closed";
    await flush();
    if (watching) {
      unwatchFile(ENABLED_FILE, syncEnabled);
      watching = false;
    }
  });

  pi.on("agent_start", async () => {
    state.status = "working";
    flush();
  });

  pi.on("agent_end", async () => {
    state.status = "idle";
    flush();
  });

  pi.on("model_select", async (event) => {
    state.model = `${event.model.provider}/${event.model.id}`;
    flush();
  });

  pi.on("turn_end", async (_event, ctx) => {
    state.turns++;
    const u = ctx.getContextUsage();
    if (u) {
      state.context.tokens = u.tokens ?? state.context.tokens;
      state.context.contextWindow = u.contextWindow;
    }
    flush();
  });

  pi.on("message_end", async (event) => {
    const m: any = event.message;
    if (m.role !== "assistant" || !m.usage) return;
    if (m.provider && m.model) state.model = `${m.provider}/${m.model}`;
    // monotonic counters: spent tokens stay spent, /tree navigation never subtracts
    state.usage.input += m.usage.input ?? 0;
    state.usage.output += m.usage.output ?? 0;
    state.usage.cacheRead += m.usage.cacheRead ?? 0;
    state.usage.cacheWrite += m.usage.cacheWrite ?? 0;
    const cost = m.usage.cost?.total ?? 0;
    state.usage.cost += cost;
    const key = m.model ?? state.model ?? "unknown";
    const mm = (state.models[key] ??= { cost: 0, output: 0 });
    mm.cost += cost;
    mm.output += m.usage.output ?? 0;
    flush();
  });

  pi.on("tool_execution_start", async (event) => {
    state.tools.unshift({
      name: event.toolName,
      detail: toolDetail(event.toolName, event.args),
      status: "running",
      ts: Date.now(),
    });
    state.tools = state.tools.slice(0, 12);
    flush();
  });

  pi.on("tool_execution_end", async (event) => {
    const t = state.tools.find((t) => t.status === "running" && t.name === event.toolName);
    if (t) t.status = event.isError ? "error" : "done";
    flush();
  });
}
