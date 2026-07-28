import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const eventData = (sessionId: string) => ({
  id: `herdr-manual:${sessionId}`,
  sessionId,
});

export default function (pi: ExtensionAPI) {
  if (process.env.HERDR_ENV !== "1" || process.env.HERDR_MANUAL_STATE !== "1") return;

  let manualSessionId: string | undefined;

  const stop = () => {
    if (!manualSessionId) return;
    pi.events.emit("subagent:async-complete", eventData(manualSessionId));
    manualSessionId = undefined;
  };

  pi.registerCommand("herdr-working", {
    description: "Mark this Pi pane working until the next agent end",
    handler: (_args, ctx) => {
      manualSessionId = ctx.sessionManager.getSessionId();
      pi.events.emit("subagent:async-started", eventData(manualSessionId));
      ctx.ui.notify("Herdr marked working until the next agent end", "info");
    },
  });

  pi.registerCommand("herdr-idle", {
    description: "Clear the manual Herdr working state",
    handler: (_args, ctx) => {
      stop();
      ctx.ui.notify("Herdr manual working state cleared", "info");
    },
  });

  pi.on("agent_end", stop);
}
