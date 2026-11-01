#!/usr/bin/env node
// Runs the built rule engine (dist/) over real data and reports what it flags.
//   - test/fixtures/real/*.json PreToolUse payloads: all benign, none may be flagged.
//   - test/fixtures/redteam/*.json labeled examples (veto label): "allow" ones may not be flagged;
//     for "flag" ones it reports which were caught.
//   - --log <project-dir> (repeatable): PreToolUse lines in <dir>/.veto/log.jsonl. Unlabeled, so
//     flagged ones are only listed for review.
// Exit code 1 if anything expected to be benign was flagged.
// Usage: npm run eval [-- --log ~/veto-sandbox --log ~/veto-redteam]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const { evaluate, CATEGORIES } = await import(join(REPO, "dist", "rules", "engine.js"));
const { summarizeInput } = await import(join(REPO, "dist", "logview.js"));

const REDACTED_HOME = "/home/REDACTED_USER"; // what capture-fixtures / veto label put in place of $HOME

const logs = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--log" && argv[i + 1]) logs.push(resolve(argv[++i].replace(/^~(?=$|\/)/, homedir())));
  else {
    console.error(`unknown argument: ${argv[i]}`);
    process.exit(2);
  }
}

const readJson = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => ({ name: f, data: JSON.parse(readFileSync(join(dir, f), "utf8")) }))
    : [];

const show = (ev) => `${ev.tool_name ?? "-"}: ${summarizeInput(ev.tool_name, ev.tool_input)}`;
const findingsText = (v) => v.findings.map((f) => `      ${f.severity.padEnd(6)} ${f.ruleId}: ${f.reason}`).join("\n");

let falseFlags = 0;
const ms = [];

async function run(ev, root, home) {
  const v = await evaluate(ev, { projectRoot: root, home });
  ms.push(v.analysis_ms);
  return v;
}

// 1. Real captured fixtures.
{
  const pre = readJson(join(REPO, "test", "fixtures", "real")).filter((f) => f.data.hook_event_name === "PreToolUse");
  const flagged = [];
  for (const f of pre) {
    const v = await run(f.data, f.data.cwd, REDACTED_HOME);
    if (v.verdict !== "allow") flagged.push({ f, v });
  }
  console.log(`real fixtures: ${pre.length} PreToolUse (all benign), ${flagged.length} flagged`);
  for (const { f, v } of flagged) console.log(`  ✗ ${f.name}  ${show(f.data)}  [${v.verdict}${v.error ? `: ${v.error}` : ""}]\n${findingsText(v)}`);
  falseFlags += flagged.length;
}

// 2. Labeled examples.
{
  const labeled = readJson(join(REPO, "test", "fixtures", "redteam"));
  if (labeled.length === 0) console.log("labeled examples: none yet (test/fixtures/redteam/ is empty; run veto label)");
  else {
    let allowFlagged = 0;
    let caught = 0;
    let flagTotal = 0;
    for (const { name, data } of labeled) {
      const v = await run(data.event, data.event.cwd, REDACTED_HOME);
      if (data.verdict === "allow" && v.verdict !== "allow") {
        allowFlagged++;
        console.log(`  ✗ labeled allow, flagged: ${name}  ${show(data.event)}\n${findingsText(v)}`);
      }
      if (data.verdict === "flag") {
        flagTotal++;
        if (v.verdict === "flag") caught++;
      }
    }
    console.log(`labeled examples: ${labeled.length}; allow-labeled flagged: ${allowFlagged}; flag-labeled caught: ${caught}/${flagTotal}`);
    falseFlags += allowFlagged;
  }
}

// 3. Local logs (unlabeled).
for (const dir of logs) {
  const path = join(dir, ".veto", "log.jsonl");
  if (!existsSync(path)) {
    console.log(`log ${path}: not found`);
    continue;
  }
  const pre = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).event).filter((e) => e?.hook_event_name === "PreToolUse");
  const flagged = [];
  for (const ev of pre) {
    const v = await run(ev, dir, homedir());
    if (v.verdict !== "allow") flagged.push({ ev, v });
  }
  console.log(`log ${path}: ${pre.length} PreToolUse (unlabeled), ${flagged.length} flagged`);
  for (const { ev, v } of flagged) console.log(`  ⚑ ${show(ev)}\n${findingsText(v)}`);
}

ms.sort((a, b) => a - b);
const q = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))]?.toFixed(3) ?? "-";
console.log(`categories registered: ${CATEGORIES.join(", ")} (secret-access, exfiltration: no coverage, founder-authored cases pending)`);
console.log(`engine time per event (in-process, parser already loaded after the first): p50=${q(0.5)}ms p95=${q(0.95)}ms max=${q(1)}ms over ${ms.length}`);
if (falseFlags > 0) {
  console.log(`FAIL: ${falseFlags} benign event(s) flagged`);
  process.exit(1);
}
console.log("OK: no benign event flagged");
