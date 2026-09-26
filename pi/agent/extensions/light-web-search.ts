import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const PROVIDERS = ["cliproxyapi", "openai-codex"];
const MODEL_ID = "gpt-5.6-luna";
const TIMEOUT_MS = 60_000;

const parameters = Type.Object({
  query: Type.Optional(Type.String({ maxLength: 2_000, description: "Search query." })),
  queries: Type.Optional(
    Type.Array(Type.String({ maxLength: 2_000 }), {
      maxItems: 4,
      description: "Up to 4 search angles; combined into one search.",
    }),
  ),
  numResults: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 20, description: "Maximum sources to return." }),
  ),
  recencyFilter: Type.Optional(
    Type.Union([
      Type.Literal("day"),
      Type.Literal("week"),
      Type.Literal("month"),
      Type.Literal("year"),
    ], { description: "Prefer recent sources." }),
  ),
  domainFilter: Type.Optional(
    Type.Array(Type.String({ maxLength: 255 }), {
      maxItems: 100,
      description: "Allowed domains; prefix with - to exclude.",
    }),
  ),
}, { additionalProperties: false });

type Parameters = Static<typeof parameters>;
type Source = { title: string; url: string; snippet?: string };
type ParsedResponse = { output: unknown[]; webSearchCallSeen: boolean };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    details: { error: message },
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return record(JSON.parse(Buffer.from(padded, "base64").toString("utf8")));
  } catch {
    return undefined;
  }
}

function accountId(token: string): string | undefined {
  const auth = record(decodeJwtPayload(token)?.["https://api.openai.com/auth"]);
  const value = auth?.chatgpt_account_id;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeDomain(value: string): string | undefined {
  let input = value.trim().toLowerCase();
  const blocked = input.startsWith("-");
  if (blocked) input = input.slice(1).trim();
  if (!input) return undefined;
  try {
    input = new URL(input.includes("://") ? input : `https://${input}`).hostname;
  } catch {
    input = input.split("/")[0]?.split(":")[0] ?? "";
  }
  input = input.replace(/^\.+|\.+$/g, "");
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input)
    ? `${blocked ? "-" : ""}${input}`
    : undefined;
}

function domainFilters(values: string[] | undefined): { allowed_domains?: string[]; blocked_domains?: string[] } | undefined {
  if (!values?.length) return undefined;
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const value of values) {
    const domain = normalizeDomain(value);
    if (!domain) continue;
    const target = domain.startsWith("-") ? blocked : allowed;
    const clean = domain.replace(/^-/, "");
    if (!target.includes(clean)) target.push(clean);
  }
  return allowed.length || blocked.length
    ? {
        ...(allowed.length ? { allowed_domains: allowed } : {}),
        ...(blocked.length ? { blocked_domains: blocked } : {}),
      }
    : undefined;
}

function queryValues(params: Parameters): string[] {
  const values = params.queries?.length ? params.queries : params.query ? [params.query] : [];
  return values.map((value) => value.trim()).filter(Boolean);
}

function formatQueries(queries: string[]): string | undefined {
  if (!queries.length) return undefined;
  return queries.length === 1
    ? queries[0]
    : queries.map((query, index) => `${index + 1}. ${query}`).join("\n");
}

function searchText(params: Parameters): string | undefined {
  return formatQueries(queryValues(params));
}

function relaxedRequest(params: Parameters): { query: string; params: Parameters } | undefined {
  const queries = queryValues(params);
  const relaxed = queries
    .map((query) => query.replace(/\bsite:\S+\s*/giu, "").trim())
    .filter(Boolean);
  const queryChanged = relaxed.some((query, index) => query !== queries[index]);
  if (!queryChanged && !params.domainFilter?.length) return undefined;
  const query = formatQueries(relaxed);
  return query ? { query, params: params.domainFilter?.length ? { ...params, domainFilter: undefined } : params } : undefined;
}

function instructions(params: Parameters): string {
  const lines = [
    "Search the web and answer concisely using only the web results.",
    "Cite sources inline and end with a short Sources list containing clickable URLs.",
    "If restrictive filters return no sources, retry with a broader query before concluding that nothing was found.",
  ];
  if (params.recencyFilter) {
    const labels = { day: "past 24 hours", week: "past week", month: "past month", year: "past year" };
    lines.push(`Prefer sources from the ${labels[params.recencyFilter]}.`);
  }
  const filters = domainFilters(params.domainFilter);
  if (filters?.allowed_domains) lines.push(`Only use: ${filters.allowed_domains.join(", ")}.`);
  if (filters?.blocked_domains) lines.push(`Do not use: ${filters.blocked_domains.join(", ")}.`);
  return lines.join(" ");
}

async function parseResponse(response: Response): Promise<ParsedResponse> {
  const text = await response.text();
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    const payload = Array.isArray(parsed) ? { output: parsed } : record(parsed) ?? {};
    const output = Array.isArray(payload.output) ? payload.output : [];
    return { output, webSearchCallSeen: output.some((item) => record(item)?.type === "web_search_call") };
  }

  const outputItems: unknown[] = [];
  let completed: Record<string, unknown> | undefined;
  let webSearchCallSeen = false;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") continue;
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = record(JSON.parse(data));
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (typeof parsed.type === "string" && parsed.type.startsWith("response.web_search_call")) {
      webSearchCallSeen = true;
    }
    if (parsed.type === "response.output_item.done" && parsed.item) {
      outputItems.push(parsed.item);
      webSearchCallSeen ||= record(parsed.item)?.type === "web_search_call";
    }
    if ((parsed.type === "response.done" || parsed.type === "response.completed")) {
      completed = record(parsed.response);
    }
  }

  if (completed) {
    const output = Array.isArray(completed.output) && completed.output.length ? completed.output : outputItems;
    return { output, webSearchCallSeen: webSearchCallSeen || output.some((item) => record(item)?.type === "web_search_call") };
  }
  if (outputItems.length) return { output: outputItems, webSearchCallSeen };
  throw new Error("Codex returned no parseable response");
}

function cleanUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.searchParams.get("utm_source") === "openai") url.searchParams.delete("utm_source");
    return url.toString();
  } catch {
    return value;
  }
}

function addSource(sources: Source[], seen: Set<string>, value: unknown, title: unknown, snippet = ""): void {
  if (typeof value !== "string" || !value.trim()) return;
  const url = cleanUrl(value);
  if (seen.has(url)) return;
  seen.add(url);
  sources.push({
    title: typeof title === "string" && title.trim() ? title : url,
    url,
    ...(snippet ? { snippet } : {}),
  });
}

function extractSources(output: unknown[], limit: number): Source[] {
  const sources: Source[] = [];
  const seen = new Set<string>();
  for (const item of output) {
    const value = record(item);
    if (!value) continue;
    if (value.type === "message" && Array.isArray(value.content)) {
      for (const part of value.content) {
        const annotations = record(part)?.annotations;
        if (!Array.isArray(annotations)) continue;
        for (const annotation of annotations) {
          const citation = record(annotation);
          if (citation?.type === "url_citation") addSource(sources, seen, citation.url, citation.title);
        }
      }
    }
    if (value.type !== "web_search_call") continue;
    const action = record(value.action);
    for (const group of [action?.sources, value.sources, value.results]) {
      if (!Array.isArray(group)) continue;
      for (const source of group) {
        const item = record(source);
        if (item) addSource(sources, seen, item.url ?? item.source_website_url, item.title ?? item.caption);
      }
    }
  }
  return sources.slice(0, limit);
}

function extractAnswer(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    const value = record(item);
    if (value?.type !== "message" || !Array.isArray(value.content)) continue;
    for (const part of value.content) {
      const text = record(part)?.text;
      if (typeof text === "string" && text.trim()) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

async function resolveAuth(ctx: ExtensionContext, provider: string): Promise<{ apiKey: string; headers: Record<string, string>; url: string }> {
  let model = ctx.modelRegistry.find(provider, MODEL_ID);
  if (!model) {
    await ctx.modelRegistry.refresh();
    model = ctx.modelRegistry.find(provider, MODEL_ID);
  }
  if (!model) throw new Error(`${provider}/${MODEL_ID} is not registered`);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  if (!auth.apiKey) throw new Error(`No credentials for ${provider}/${MODEL_ID}`);
  const baseUrl = (auth.baseUrl ?? model.baseUrl).replace(/\/+$/, "");
  return { apiKey: auth.apiKey, headers: auth.headers ?? {}, url: `${baseUrl}/codex/responses` };
}

type SearchOutput = { answer: string; sources: Source[] };

async function runSearch(
  query: string,
  params: Parameters,
  signal: AbortSignal,
  auth: { apiKey: string; headers: Record<string, string>; url: string },
  headers: Record<string, string>,
): Promise<SearchOutput> {
  const filters = domainFilters(params.domainFilter);
  const response = await fetch(auth.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: MODEL_ID,
      instructions: instructions(params),
      input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
      tools: [{ type: "web_search", ...(filters ? { filters } : {}) }],
      include: ["web_search_call.action.sources"],
      store: false,
      stream: true,
      tool_choice: "required",
      parallel_tool_calls: true,
    }),
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text()).replaceAll(auth.apiKey, "[redacted]").slice(0, 300);
    throw new Error(`Codex web search failed (${response.status}): ${detail}`);
  }

  const parsed = await parseResponse(response);
  if (!parsed.webSearchCallSeen) throw new Error("Codex returned no web search call");
  return {
    answer: extractAnswer(parsed.output),
    sources: extractSources(parsed.output, params.numResults ?? 5),
  };
}

async function search(params: Parameters, signal: AbortSignal | undefined, ctx: ExtensionContext) {
  const query = searchText(params);
  if (!query) return errorResult("No query provided. Use 'query' or 'queries'.");
  const errors: string[] = [];
  for (const provider of PROVIDERS) {
    signal?.throwIfAborted();
    try {
      return await searchWith(provider, query, params, signal, ctx);
    } catch (error) {
      if (signal?.aborted) throw error;
      errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(errors.join("; "));
}

async function searchWith(provider: string, query: string, params: Parameters, signal: AbortSignal | undefined, ctx: ExtensionContext) {
  const auth = await resolveAuth(ctx, provider);
  const headers: Record<string, string> = {
    ...auth.headers,
    Authorization: `Bearer ${auth.apiKey}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "responses=experimental",
    originator: "pi",
  };
  const id = accountId(auth.apiKey);
  if (id) headers["chatgpt-account-id"] = id;
  const searchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);

  let result = await runSearch(query, params, searchSignal, auth, headers);
  const retry = !result.sources.length ? relaxedRequest(params) : undefined;
  if (retry && retry.query !== query) {
    const broader = await runSearch(retry.query, retry.params, searchSignal, auth, headers);
    if (broader.sources.length || !result.answer) result = broader;
  }
  if (!result.answer && !result.sources.length) throw new Error("Codex returned no answer or sources");
  return {
    content: [{ type: "text" as const, text: result.answer || result.sources.map((source) => `${source.title}: ${source.url}`).join("\n") }],
    details: { provider, model: MODEL_ID, sources: result.sources },
  };
}

export default function lightWebSearchExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web with Codex and return a concise cited answer.",
    promptSnippet: "Search with Codex; use queries for multiple angles and retry broadly if filters return no sources.",
    parameters,
    async execute(_callId, params, signal, _onUpdate, ctx) {
      try {
        return await search(params, signal, ctx);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
