import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const loaded = await jiti.import(new URL("../extensions/index.ts", import.meta.url).pathname);
export const extension = loaded.default ?? loaded;

export async function createHarness(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-context-test-"));
  const manager = options.manager ?? SessionManager.create(dir, dir);
  await options.setupManager?.(manager, dir);
  const settings = SettingsManager.inMemory({
    compaction: {
      enabled: true,
      keepRecentTokens: options.keepRecentTokens ?? 1,
      reserveTokens: options.reserveTokens ?? 1_000,
    },
    retry: { enabled: false },
  });
  const baseModel = getModel("anthropic", "claude-sonnet-4-5");
  const model = { ...baseModel, contextWindow: options.contextWindow ?? 80_000, maxTokens: 512 };
  const providerRequests = [];
  const lifecycleEvents = [];
  const lifecycleObserver = (pi) => {
    pi.on("session_before_tree", (event) => {
      lifecycleEvents.push({ kind: "before_tree", eventType: event.type, targetId: event.preparation.targetId });
    });
    pi.on("session_tree", (event) => {
      lifecycleEvents.push({ kind: "tree", eventType: event.type, newLeafId: event.newLeafId, oldLeafId: event.oldLeafId, leafAfterHooks: manager.getLeafId() });
    });
    pi.on("session_compact", (event) => {
      lifecycleEvents.push({ kind: "compact", eventType: event.type, reason: event.reason });
    });
    pi.on("session_compact_failed", (event) => {
      lifecycleEvents.push({ kind: "compact_failed", eventType: event.type, reason: event.reason, aborted: event.aborted });
    });
  };
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      ...(options.beforeExtensions ?? []),
      extension,
      lifecycleObserver,
      ...(options.afterExtensions ?? []),
      (pi) => pi.registerProvider("anthropic", {
        api: "anthropic-messages",
        models: [model],
        streamSimple() {
          providerRequests.push("native-provider-call");
          throw new Error("Unexpected native provider call, including a summarizer");
        },
      }),
    ],
    systemPromptOverride: () => options.systemPrompt ?? "Test system prompt.",
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: join(dir, "models.json"),
    allowModelNetwork: false,
  });
  await modelRuntime.setRuntimeApiKey("anthropic", "TEST-KEY");
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    sessionManager: manager,
    settingsManager: settings,
    resourceLoader: loader,
    modelRuntime,
    model,
    noTools: "builtin",
  });
  const requests = [];
  const responses = [];
  session.agent.streamFunction = (currentModel, context, requestOptions) => {
    requestOptions?.signal?.throwIfAborted();
    requests.push({
      systemPrompt: context.systemPrompt ?? "",
      messages: structuredClone(context.messages),
      tools: (context.tools ?? []).map((tool) => tool.name),
      toolDefinitions: (context.tools ?? []).map(({ name, description, parameters }) => ({
        name,
        description,
        parameters: structuredClone(parameters),
      })),
    });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected model request");
    const message = { ...next, api: currentModel.api, provider: currentModel.provider, model: currentModel.id };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } else {
        stream.push({ type: "done", reason: message.stopReason, message });
      }
    });
    return stream;
  };
  const extensionErrors = [];
  await session.bindExtensions({ mode: "rpc", onError: (error) => extensionErrors.push(error) });
  return {
    dir,
    manager,
    session,
    requests,
    responses,
    extensionErrors,
    providerRequests,
    lifecycleEvents,
    async close() {
      session.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function reply(text, inputTokens = 100) {
  const message = fauxAssistantMessage(text);
  message.usage = {
    ...message.usage,
    cost: { ...message.usage.cost },
    input: inputTokens,
    output: 10,
    totalTokens: inputTokens + 10,
  };
  return message;
}

export function toolCall(name, args = {}, id = `call-${name}`) {
  return {
    ...reply(""),
    content: [{ type: "toolCall", name, arguments: args, id }],
    stopReason: "toolUse",
  };
}

export function toolCalls(calls) {
  return {
    ...reply(""),
    content: calls.map(({ name, arguments: args = {}, id }) => ({ type: "toolCall", name, arguments: args, id })),
    stopReason: "toolUse",
  };
}

export function overflow() {
  const message = reply("PROVIDER-FAILED-RESPONSE");
  message.stopReason = "error";
  message.errorMessage = "prompt is too long: 90000 tokens > 80000 maximum";
  return message;
}

export function requestText(request) {
  return JSON.stringify(request.messages);
}
