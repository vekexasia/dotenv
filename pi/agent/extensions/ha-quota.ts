import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text, matchesKey } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Quota for ALL openai-codex and anthropic credentials stored in
// pi-high-availability's ha.json. Replaces pi-quota-status: anthropic quota
// comes from api.anthropic.com/api/oauth/usage (OAuth), no HAR cookie needed.

const HA_PATH = join(homedir(), ".pi", "agent", "ha.json");
const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const STATUS_KEY = "ha-quota";
const REFRESH_MS = 300_000;

interface Cred { name: string; access: string; refresh: string; expires: number; accountId?: string; key?: string }
interface Window { remainingPct: number; resetMs?: number }
interface Quota { name: string; label: string; active?: boolean; fiveHour?: Window; weekly?: Window; error?: string }

function readCreds(provider: string): Cred[] {
  try {
    const creds = JSON.parse(readFileSync(HA_PATH, "utf8"))?.credentials?.[provider] ?? {};
    return Object.entries(creds)
      .filter(([name, v]: [string, any]) => name !== "__meta" && v?.refresh)
      .map(([name, v]: [string, any]) => ({ name, ...(v as object) }) as Cred);
  } catch { return []; }
}
function activeAuth(provider: string): Partial<Cred> | undefined {
  try { return JSON.parse(readFileSync(AUTH_PATH, "utf8"))?.[provider]; } catch { return; }
}

function isActiveCred(provider: string, cred: Cred): boolean {
  const auth = activeAuth(provider);
  return !!auth && (
    (!!cred.accountId && cred.accountId === auth.accountId) ||
    (!!cred.refresh && cred.refresh === auth.refresh) ||
    (!!cred.key && cred.key === auth.key)
  );
}
// Pretty output shows credential handle + masked email; compact status keeps handles only.
const emailCache = new Map<string, string>();
function maskEmail(email: string): string {
  const mask = (s: string) => s.length <= 2 ? s : `${s[0]}${"*".repeat(s.length - 2)}${s[s.length - 1]}`;
  const [local, domain] = email.split("@");
  if (!domain) return mask(email);
  const lastDot = domain.lastIndexOf(".");
  const name = lastDot > 0 ? domain.slice(0, lastDot) : domain;
  const tld = lastDot > 0 ? domain.slice(lastDot) : "";
  return `${mask(local)}@${mask(name)}${tld}`;
}
function quotaLabel(name: string, email?: string): string {
  return email ? `${maskEmail(name)} <${maskEmail(email)}>` : maskEmail(name);
}

const clamp = (used: number) => Math.max(0, Math.min(100, 100 - used));

function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
  return `${(h / 24).toFixed(1)}d`;
}


// ── openai-codex ───────────────────────────────────────────────────────────────
function codexAccess(cred: Cred): string | undefined {
  return cred.expires > Date.now() + 60_000 ? cred.access : undefined;
}

interface CodexWindow { used_percent?: number; reset_at?: number; reset_after_seconds?: number }

function codexWindow(w: CodexWindow | null | undefined): Window | undefined {
  if (typeof w?.used_percent !== "number") return;
  const now = Date.now();
  const resetMs = typeof w.reset_after_seconds === "number" ? now + w.reset_after_seconds * 1000
    : typeof w.reset_at === "number" ? w.reset_at * 1000 : undefined;
  return { remainingPct: clamp(w.used_percent), resetMs };
}

// Email lives in the JWT payload and is decodable even when the token is
// expired, so the label survives auth failures.
function codexLabel(cred: Cred, access?: string): string {
  const cached = emailCache.get(`codex:${cred.name}`);
  if (cached) return quotaLabel(cred.name, cached);
  for (const token of [access, cred.access]) {
    if (!token) continue;
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      const email = payload?.["https://api.openai.com/profile"]?.email ?? payload?.email;
      if (typeof email === "string") {
        emailCache.set(`codex:${cred.name}`, email);
        return quotaLabel(cred.name, email);
      }
    } catch {}
  }
  return quotaLabel(cred.name);
}

async function codexQuota(cred: Cred): Promise<Quota> {
  const access = await codexAccess(cred);
  const label = codexLabel(cred, access);
  if (!access) return { name: cred.name, label, error: "auth?" };
  try {
    const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: { Authorization: "Bearer " + access, "chatgpt-account-id": cred.accountId ?? "", originator: "pi", "User-Agent": "pi" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { name: cred.name, label, error: `${res.status}` };
    const d = await res.json() as { rate_limit?: { primary_window?: CodexWindow | null; secondary_window?: CodexWindow | null } };
    return { name: cred.name, label, fiveHour: codexWindow(d?.rate_limit?.primary_window), weekly: codexWindow(d?.rate_limit?.secondary_window) };
  } catch { return { name: cred.name, label, error: "err" }; }
}

// ── anthropic ────────────────────────────────────────────────────────────────────
function anthropicAccess(cred: Cred): string | undefined {
  return cred.expires > Date.now() + 60_000 ? cred.access : undefined;
}

function anthropicWindow(w: { utilization?: number; resets_at?: string | null } | null | undefined): Window | undefined {
  if (typeof w?.utilization !== "number") return;
  const resetMs = w.resets_at ? Date.parse(w.resets_at) : undefined;
  return { remainingPct: clamp(w.utilization), resetMs: Number.isFinite(resetMs) ? resetMs : undefined };
}

async function anthropicLabel(cred: Cred, access: string): Promise<string> {
  const cached = emailCache.get(`anthropic:${cred.name}`);
  if (cached) return quotaLabel(cred.name, cached);
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
      headers: { Authorization: "Bearer " + access, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "pi" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const email = (await res.json() as { account?: { email?: string } })?.account?.email;
      if (typeof email === "string") {
        emailCache.set(`anthropic:${cred.name}`, email);
        return quotaLabel(cred.name, email);
      }
    }
  } catch {}
  return quotaLabel(cred.name);
}

async function anthropicQuota(cred: Cred): Promise<Quota> {
  const access = await anthropicAccess(cred);
  if (!access) {
    const cached = emailCache.get(`anthropic:${cred.name}`);
    return { name: cred.name, label: quotaLabel(cred.name, cached), error: "auth?" };
  }
  const label = await anthropicLabel(cred, access);
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: "Bearer " + access, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "pi" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { name: cred.name, label, error: `${res.status}` };
    const d = await res.json() as { five_hour?: { utilization?: number; resets_at?: string | null } | null; seven_day?: { utilization?: number; resets_at?: string | null } | null };
    return { name: cred.name, label, fiveHour: anthropicWindow(d?.five_hour), weekly: anthropicWindow(d?.seven_day) };
  } catch { return { name: cred.name, label, error: "err" }; }
}

// ── display ──────────────────────────────────────────────────────────────────
// Transient failures (429s from polling, refresh hiccups) fall back to the
// last good reading for up to 30min instead of flashing errors.
const lastGood = new Map<string, { quota: Quota; at: number }>();
const LAST_GOOD_TTL_MS = 30 * 60_000;

function withFallback(key: string, quota: Quota): Quota {
  if (!quota.error) {
    lastGood.set(key, { quota, at: Date.now() });
    return quota;
  }
  const prev = lastGood.get(key);
  if (prev && Date.now() - prev.at < LAST_GOOD_TTL_MS) return prev.quota;
  return quota;
}

async function fetchAll(): Promise<{ codex: Quota[]; claude: Quota[] }> {
  const codexCreds = readCreds("openai-codex");
  const anthropicCreds = readCreds("anthropic").filter((c) => c.name === "primary" || c.expires > Date.now());
  const [codex, claude] = await Promise.all([
    Promise.all(codexCreds.map(async (c) => ({ ...withFallback(`codex:${c.name}`, await codexQuota(c)), active: isActiveCred("openai-codex", c) }))),
    Promise.all(anthropicCreds.map(async (c) => ({ ...withFallback(`anthropic:${c.name}`, await anthropicQuota(c)), active: isActiveCred("anthropic", c) }))),
  ]);
  return { codex, claude };
}

function compact(sections: { codex: Quota[]; claude: Quota[] }): string {
  const pct = (w?: Window) => w ? `${w.remainingPct.toFixed(0)}%` : "??";
  const part = (q: Quota) => q.error ? `${q.active ? "*" : ""}${maskEmail(q.name)}:${q.error}` : `${q.active ? "*" : ""}${maskEmail(q.name)} 5h:${pct(q.fiveHour)} wk:${pct(q.weekly)}`;
  const out: string[] = [];
  if (sections.codex.length) out.push(`codex[${sections.codex.map(part).join(" | ")}]`);
  if (sections.claude.length) out.push(`claude[${sections.claude.map(part).join(" | ")}]`);
  return out.join(" ") || "ha-quota: n/a";
}

function bar(w: Window | undefined, width = 20): string {
  if (!w) return "·".repeat(width);
  const filled = Math.round((w.remainingPct / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function win(w: Window | undefined): string {
  if (!w) return `${bar(w)}   ??`;
  const reset = w.resetMs ? `  ⟳ ${fmtDuration(Math.max(0, w.resetMs - Date.now()))}` : "";
  return `${bar(w)} ${w.remainingPct.toFixed(0).padStart(3)}%${reset}`;
}

function pretty(sections: { codex: Quota[]; claude: Quota[] }): string {
  const lines: string[] = [];
  const render = (title: string, quotas: Quota[]) => {
    if (!quotas.length) return;
    if (lines.length) lines.push("");
    lines.push(`▐ ${title}`);
    lines.push("");
    for (const q of quotas) {
      const marker = q.active ? "▸" : " ";
      if (q.error) {
        lines.push(`  ${marker} ${q.label}   ✗ ${q.error}`);
        lines.push("");
        continue;
      }
      lines.push(`  ${marker} ${q.label}`);
      lines.push(`      5h  ${win(q.fiveHour)}`);
      lines.push(`      wk  ${win(q.weekly)}`);
      lines.push("");
    }
  };
  render("OpenAI Codex", sections.codex);
  render("Claude", sections.claude);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n") || "ha-quota: n/a";
}

export default function haQuota(pi: ExtensionAPI) {
  let interval: ReturnType<typeof setInterval> | undefined;
  let refreshing = false;

  pi.registerCommand("ha-quota", {
    description: "Show remaining quota for all openai-codex and anthropic credentials in ha.json",
    handler: async (_args, cmdCtx) => {
      const mode = (cmdCtx as unknown as { mode?: string }).mode;
      if (mode !== "tui") {
        const sections = await fetchAll();
        process.stdout.write(`${pretty(sections)}\n`);
        return;
      }
      cmdCtx.ui.notify("Fetching quota...", "info");
      const sections = await fetchAll();
      await cmdCtx.ui.custom((_tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new Text("", 0, 0));
        container.addChild(new Text(theme.fg("accent", theme.bold("HA quota")), 2, 0));
        container.addChild(new Text("", 0, 0));
        for (const line of pretty(sections).split("\n")) container.addChild(new Text(line, 2, 0));
        container.addChild(new Text("", 0, 0));
        container.addChild(new Text(theme.fg("dim", "▸ = active credential · Enter/Esc to close"), 2, 0));
        container.addChild(new Text("", 0, 0));
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
          },
        };
      }, { overlay: true, overlayOptions: { width: "70%" } });
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (interval) clearInterval(interval);
    if (!ctx.hasUI) return;
    const tick = () => {
      if (refreshing) return;
      refreshing = true;
      void fetchAll()
        .then((sections) => ctx.ui.setStatus(STATUS_KEY, compact(sections)))
        .finally(() => { refreshing = false; });
    };
    tick();
    interval = setInterval(tick, REFRESH_MS);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (interval) clearInterval(interval);
    interval = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
