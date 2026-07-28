import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

type ToolDisplayApi = {
  version: 1;
  decorateTool<T extends Record<string, unknown>>(
    tool: T,
    adapter?: Record<string, unknown>,
  ): T;
};

const API_KEY = Symbol.for("pi-tool-display.api.v1");
const PENDING_KEY = Symbol.for("pi-tool-display.pendingDecorations.v1");
const MARK = Symbol.for("hashline-tool-display-bridge.decorated");

const toolDisplayConfigPath = join(
  process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? homedir(), ".pi", "agent"),
  "extensions",
  "pi-tool-display",
  "config.json",
);

type GlobalWithToolDisplay = typeof globalThis & {
  [API_KEY]?: ToolDisplayApi;
  [PENDING_KEY]?: Array<{ tool: Record<string, unknown>; adapter?: Record<string, unknown> }>;
};
type BridgeTool = ToolDefinition & Record<string | symbol, unknown>;

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function keepToolDisplayOffRead(): void {
  const config = readJson(toolDisplayConfigPath);
  const ownership = {
    ...((config.registerToolOverrides as Record<string, unknown> | undefined) ?? {}),
    read: false,
  };
  const next = { ...config, registerToolOverrides: ownership };
  mkdirSync(dirname(toolDisplayConfigPath), { recursive: true });
  writeFileSync(toolDisplayConfigPath, `${JSON.stringify(next, null, 2)}\n`);
}

function decorateInPlace(tool: BridgeTool): void {
  if (tool.name !== "read" || tool[MARK]) return;

  const adapter = { kind: "read", overrideExistingRenderers: true };
  const globals = globalThis as GlobalWithToolDisplay;
  const api = globals[API_KEY];

  if (api?.version === 1 && typeof api.decorateTool === "function") {
    Object.assign(tool, api.decorateTool(tool as Record<string, unknown>, adapter));
  } else {
    const queue = globals[PENDING_KEY] ?? [];
    queue.push({ tool: tool as Record<string, unknown>, adapter });
    globals[PENDING_KEY] = queue;
  }

  tool[MARK] = true;
}

export default function hashlineToolDisplayBridge(pi: ExtensionAPI): void {
  keepToolDisplayOffRead();

  const originalRegisterTool = pi.registerTool;
  pi.registerTool = function registerToolWithHashlineDisplay(
    this: ExtensionAPI,
    tool: ToolDefinition,
  ): void {
    decorateInPlace(tool as BridgeTool);
    return originalRegisterTool.call(this, tool);
  } as ExtensionAPI["registerTool"];
}
