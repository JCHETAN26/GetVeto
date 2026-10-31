#!/usr/bin/env node
// Copy the last N real hook events from a project's .veto/log.jsonl into test/fixtures/real/,
// redacting home-directory paths and secret-looking strings.
//
// Usage: npm run capture-fixtures -- --from <project-dir> [-n N]
//   --from  project whose .veto/log.jsonl to read (default: current directory)
//   -n      number of most recent entries to capture (default: 20)
//
// Requires `npm run build` first (it uses dist/redact.js).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { redactValue, redactString } = await import(join(repoRoot, "dist", "redact.js"));

let from = process.cwd();
let n = 20;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--from") from = resolve(args[++i] ?? "");
  else if (args[i] === "-n") n = Number(args[++i]);
  else {
    console.error(`unknown argument: ${args[i]}`);
    process.exit(1);
  }
}
if (!Number.isInteger(n) || n <= 0) {
  console.error("-n expects a positive integer");
  process.exit(1);
}

const logPath = join(from, ".veto", "log.jsonl");
if (!existsSync(logPath)) {
  console.error(`No log at ${logPath}. Run the demo first (veto init + Claude Code in that folder).`);
  process.exit(1);
}

const entries = [];
for (const line of readFileSync(logPath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    const v = JSON.parse(line);
    if (v && typeof v.event === "object" && v.event) entries.push(v.event);
  } catch {
    /* skip malformed */
  }
}
const picked = entries.slice(-n);
if (picked.length === 0) {
  console.error(`No entries in ${logPath}.`);
  process.exit(1);
}

const outDir = join(repoRoot, "test", "fixtures", "real");
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (f.endsWith(".json")) rmSync(join(outDir, f));

let username;
try {
  username = userInfo().username;
} catch {}
const opts = { homeDir: homedir(), username };
// The project path itself can identify the user's machine layout; replace it too.
const projectPlaceholder = "/REDACTED_PROJECT";

const safe = (s) => String(s ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
picked.forEach((event, idx) => {
  let text = JSON.stringify(redactValue(event, opts), null, 2);
  const redactedFrom = JSON.stringify(redactValue(from, opts)).slice(1, -1);
  text = text.split(JSON.stringify(from).slice(1, -1)).join(projectPlaceholder);
  text = text.split(redactedFrom).join(projectPlaceholder);
  // Second pass over the serialized JSON catches secrets split across a key and its value
  // (e.g. {"password": "..."}) that per-string redaction can't see. Keep it only if valid JSON.
  const second = redactString(text, opts);
  try {
    JSON.parse(second);
    text = second;
  } catch {
    console.warn(`warning: second-pass redaction broke JSON for entry ${idx + 1}; kept first pass only`);
  }
  const name = `${String(idx + 1).padStart(2, "0")}-${safe(event.hook_event_name)}-${safe(event.tool_name)}.json`;
  writeFileSync(join(outDir, name), text + "\n");
  console.log(`wrote test/fixtures/real/${name}`);
});
console.log(`\nCaptured ${picked.length} event(s) from ${logPath}.`);
console.log("REVIEW these files before committing: redaction is best-effort.");
