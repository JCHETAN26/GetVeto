#!/usr/bin/env node
// Runs the built rule engine (build/, the tsc output of the same sources bundled into dist/) over real data and reports what it flags.
//   - test/fixtures/real/*.json PreToolUse payloads: each must get its expected verdict from
//     test/fixtures/real-expected.json (anything not listed there is benign and must be allowed).
//   - test/fixtures/redteam/*.json labeled examples (veto label): "allow" ones may not be flagged;
//     for "flag" ones it reports which were caught.
//   - --log <project-dir | log.jsonl file> (repeatable): PreToolUse lines in <dir>/.veto/log.jsonl
//     or in a saved log file. Unlabeled, so flagged ones are listed for review. Lines that carry a
//     verdict from when they were logged are compared, and changed verdicts are listed.
// Exit code 1 if a real fixture didn't get its expected verdict, or a benign one was flagged.
// Usage: npm run eval [-- --log ~/veto-sandbox --log ~/veto-redteam]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const { evaluate, CATEGORIES } = await import(join(REPO, "build", "rules", "engine.js"));
const { summarizeInput } = await import(join(REPO, "build", "logview.js"));

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
  const expected = JSON.parse(readFileSync(join(REPO, "test", "fixtures", "real-expected.json"), "utf8"));
  const pre = readJson(join(REPO, "test", "fixtures", "real")).filter((f) => f.data.hook_event_name === "PreToolUse");
  let benign = 0;
  let benignFlagged = 0;
  const expectedFlags = [];
  for (const f of pre) {
    const v = await run(f.data, f.data.cwd, REDACTED_HOME);
    const want = expected[f.name];
    if (want) {
      const ids = [...new Set(v.findings.map((x) => x.ruleId))];
      const ok = v.verdict === want.verdict && JSON.stringify(ids) === JSON.stringify(want.ruleIds);
      expectedFlags.push(`  ${ok ? "✓" : "✗"} ${f.name}  ${show(f.data)}  expected ${want.verdict} [${want.ruleIds.join(", ")}], got ${v.verdict}\n${findingsText(v)}`);
      if (!ok) falseFlags++;
    } else {
      benign++;
      if (v.verdict !== "allow") {
        benignFlagged++;
        console.log(`  ✗ ${f.name}  ${show(f.data)}  [${v.verdict}${v.error ? `: ${v.error}` : ""}]\n${findingsText(v)}`);
      }
    }
  }
  console.log(`real fixtures: ${pre.length} PreToolUse; ${benign} benign, ${benignFlagged} of them flagged; ${expectedFlags.length} expected to flag`);
  for (const l of expectedFlags) console.log(l);
  falseFlags += benignFlagged;
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
for (const target of logs) {
  const isFile = existsSync(target) && statSync(target).isFile();
  const path = isFile ? target : join(target, ".veto", "log.jsonl");
  if (!existsSync(path)) {
    console.log(`log ${path}: not found`);
    continue;
  }
  const pre = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.event?.hook_event_name === "PreToolUse");
  const flagged = [];
  const changed = [];
  for (const line of pre) {
    const ev = line.event;
    // A saved log file has no project dir next to it: use the event's cwd (where the session ran).
    const v = await run(ev, isFile ? ev.cwd : target, homedir());
    if (v.verdict !== "allow") flagged.push({ ev, v, ts: line.ts });
    if (typeof line.verdict === "string" && line.verdict !== v.verdict) changed.push({ ev, v, ts: line.ts, was: line.verdict });
  }
  const logged = pre.filter((l) => typeof l.verdict === "string").length;
  console.log(`log ${path}: ${pre.length} PreToolUse (unlabeled), ${flagged.length} flagged; ${changed.length} of ${logged} logged verdicts changed`);
  for (const { ev, v, ts } of flagged) console.log(`  ⚑ ${ts}  ${show(ev)}\n${findingsText(v)}`);
  for (const { ev, v, ts, was } of changed) console.log(`  Δ ${ts}  ${was} → ${v.verdict}  ${show(ev)}`);
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
