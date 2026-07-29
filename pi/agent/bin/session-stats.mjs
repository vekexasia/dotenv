#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";

function parseDate(value, label) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a valid datetime: ${value}`);
  return ms;
}

function sessionDirectory() {
  const configured = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (configured) return resolve(configured.replace(/^~(?=$|\/)/, homedir()));
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR.replace(/^~(?=$|\/)/, homedir()))
    : join(homedir(), ".pi", "agent");
  return join(agentDir, "sessions");
}

async function* jsonlFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(path);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}

function bucket() {
  return { sessions: new Set(), records: 0, input: 0, output: 0, cachedInput: 0, cost: 0 };
}

function addUsage(target, path, usage) {
  target.sessions.add(path);
  target.records += 1;
  target.input += Number(usage.input) || 0;
  target.output += Number(usage.output) || 0;
  target.cachedInput += Number(usage.cacheRead) || 0;
  target.cost += Number(usage.cost?.total) || 0;
}

async function collectStats(startMs, endMs, directory) {
  const providers = new Map();
  const models = new Map();
  let files = 0;
  let activeSessions = 0;
  let usageRecords = 0;
  let malformedLines = 0;
  let missingCostRecords = 0;

  for await (const path of jsonlFiles(directory)) {
    files += 1;
    let active = false;
    const usages = [];
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        malformedLines += 1;
        continue;
      }
      const timestamp = Date.parse(record.timestamp ?? "");
      if (!Number.isFinite(timestamp) || timestamp <= startMs || timestamp > endMs) continue;
      active = true;
      const message = record.message;
      if (message?.role !== "assistant" || !message.usage) continue;
      usages.push({
        provider: message.provider || "unknown",
        model: message.model || "unknown",
        usage: message.usage,
      });
    }
    if (!active) continue;
    activeSessions += 1;
    for (const { provider, model, usage } of usages) {
      usageRecords += 1;
      if (!Number.isFinite(Number(usage.cost?.total))) missingCostRecords += 1;
      addUsage(providers.get(provider) ?? (providers.set(provider, bucket()), providers.get(provider)), path, usage);
      const modelKey = `${provider}\0${model}`;
      addUsage(models.get(modelKey) ?? (models.set(modelKey, bucket()), models.get(modelKey)), path, usage);
    }
  }

  const total = bucket();
  total.records = usageRecords;
  for (const row of providers.values()) {
    total.input += row.input;
    total.output += row.output;
    total.cachedInput += row.cachedInput;
    total.cost += row.cost;
  }
  total.sessions = new Set([...providers.values()].flatMap((row) => [...row.sessions]));
  return { files, activeSessions, usageRecords, malformedLines, missingCostRecords, providers, models, total };
}

function number(value) {
  return value.toLocaleString("en-US");
}

function money(value) {
  return `$${value.toFixed(4)}`;
}

function statsValues(stats) {
  return [number(stats.sessions.size), number(stats.records), number(stats.input), number(stats.output), number(stats.cachedInput), money(stats.cost)];
}

function tableLine(values, widths, header = false) {
  return `| ${values.map((value, index) => {
    const text = String(value);
    return index === 0 || header ? text.padEnd(widths[index]) : text.padStart(widths[index]);
  }).join(" | ")} |`;
}

function printTable(title, headers, rows, total) {
  const values = [
    ...rows.map(([label, stats]) => [label, ...statsValues(stats)]),
    ["TOTAL", ...statsValues(total)],
  ];
  const widths = headers.map((header, index) => Math.max(String(header).length, ...values.map((value) => String(value[index]).length)));
  const border = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
  console.log(`\n${title}`);
  console.log(border);
  console.log(tableLine(headers, widths, true));
  console.log(border);
  for (const value of values.slice(0, -1)) console.log(tableLine(value, widths));
  console.log(border);
  console.log(tableLine(values.at(-1), widths));
  console.log(border);
}

function usage() {
  console.error("Usage: session-stats.mjs <start-datetime> [end-datetime]");
  console.error("Example: session-stats.mjs 2026-07-25T21:15:00Z 2026-07-26T19:29:09Z");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  if (args.length < 1 || args.length > 2) {
    usage();
    process.exitCode = 2;
    return;
  }

  const startMs = parseDate(args[0], "start datetime");
  const endMs = args[1] ? parseDate(args[1], "end datetime") : Date.now();
  if (startMs >= endMs) throw new Error("end datetime must be after start datetime");

  const directory = sessionDirectory();
  const stats = await collectStats(startMs, endMs, directory);
  console.log(`Interval: (${new Date(startMs).toISOString()}, ${new Date(endMs).toISOString()}]`);
  console.log(`Session directory: ${directory}`);
  console.log(`Scanned ${number(stats.files)} files; ${number(stats.activeSessions)} active sessions; ${number(stats.usageRecords)} usage records; ${number(stats.malformedLines)} malformed lines; ${number(stats.missingCostRecords)} records missing Pi cost data.`);
  const headers = ["Provider", "Sessions", "Usage records", "Input", "Output", "Cached input", "Spent (USD)"];
  printTable("By provider", headers, [...stats.providers.entries()].sort(), stats.total);
  printTable("By model", ["Provider/model", ...headers.slice(1)], [...stats.models.entries()].sort().map(([key, value]) => [key.replace("\0", "/"), value]), stats.total);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`session-stats: ${error.message}`);
    process.exitCode = 1;
  });
}

export { collectStats, parseDate, sessionDirectory };
