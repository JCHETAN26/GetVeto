#!/usr/bin/env node
// Copy the last N real hook events from a project's .veto/log.jsonl into test/fixtures/real/,
// redacting home-directory paths and secret-looking strings.
//
// Usage: npm run capture-fixtures -- --from <project-dir> [-n N]
//   --from  project whose .veto/log.jsonl to read (default: current directory)
//   -n      number of most recent entries to capture (default: 20)
//   --append  keep existing fixtures and number new ones after them (default: replace them all)
//   --log   read this log file instead of <from>/.veto/log.jsonl (e.g. a saved copy)
//   --ts    capture only the entry with this exact "ts" (implies --append)
//
// Requires `npm run build` first (it uses dist/redact.js).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { redactEvent } = await import(join(repoRoot, "dist", "redact.js"));

let from = process.cwd();
let n = 20;
let append = false;
let logFile = null;
let onlyTs = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--from") from = resolve(args[++i] ?? "");
  else if (args[i] === "-n") n = Number(args[++i]);
  else if (args[i] === "--append") append = true;
  else if (args[i] === "--log") logFile = resolve(args[++i] ?? "");
  else if (args[i] === "--ts") {
    onlyTs = args[++i] ?? "";
    append = true;
  }
  else {
    console.error(`unknown argument: ${args[i]}`);
    process.exit(1);
  }
}
if (!Number.isInteger(n) || n <= 0) {
  console.error("-n expects a positive integer");
  process.exit(1);
}

const logPath = logFile ?? join(from, ".veto", "log.jsonl");
if (!existsSync(logPath)) {
  console.error(`No log at ${logPath}. Run the demo first (veto init + Claude Code in that folder).`);
  process.exit(1);
}

const entries = [];
for (const line of readFileSync(logPath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    const v = JSON.parse(line);
    if (v && typeof v.event === "object" && v.event && (onlyTs === null || v.ts === onlyTs)) entries.push(v.event);
  } catch {
    /* skip malformed */
  }
}
const picked = entries.slice(-n);
if (picked.length === 0) {
  console.error(onlyTs === null ? `No entries in ${logPath}.` : `No entry with ts ${onlyTs} in ${logPath}.`);
  process.exit(1);
}

const outDir = join(repoRoot, "test", "fixtures", "real");
mkdirSync(outDir, { recursive: true });
const existing = readdirSync(outDir).filter((f) => f.endsWith(".json")).sort();
let start = 0;
if (append) {
  // Continue numbering after the existing fixtures; never delete anything.
  start = existing.reduce((m, f) => Math.max(m, Number.parseInt(f, 10) || 0), 0);
} else {
  for (const f of existing) rmSync(join(outDir, f));
}

let username;
try {
  username = userInfo().username;
} catch {}
const opts = { homeDir: homedir(), username, projectDir: from };

const safe = (s) => String(s ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
picked.forEach((event, idx) => {
  const { value, secondPassApplied } = redactEvent(event, opts);
  if (!secondPassApplied) console.warn(`warning: second-pass redaction broke JSON for entry ${idx + 1}; kept first pass only`);
  const name = `${String(start + idx + 1).padStart(2, "0")}-${safe(event.hook_event_name)}-${safe(event.tool_name)}.json`;
  writeFileSync(join(outDir, name), JSON.stringify(value, null, 2) + "\n");
  console.log(`wrote test/fixtures/real/${name}`);
});
console.log(`\nCaptured ${picked.length} event(s) from ${logPath}.`);
console.log("REVIEW these files before committing: redaction is best-effort.");
