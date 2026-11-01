// `veto allow --once`, `veto allow <ruleId>`, `veto deny <ruleId>`: overrides the user makes in
// their own terminal. Each one is recorded in .veto/log.jsonl as {"ts", "veto": {...}} (no
// "event": it isn't a Claude Code event). The agent can't run these: see
// rules/self-protection/override.ts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfig, saveConfig } from "./config.js";
import { formatTime, parseLog, summarizeInput, type LogEntry } from "./logview.js";
import { ONCE_TTL_MS, overridePath, readOverrideFile, type FindingKey, type OnceOverride } from "./override.js";
import { allRules } from "./rules/engine.js";
import { appendPrivate, findVetoRoot, LOG_FILE, VETO_DIR, writePrivate } from "./storage.js";

type Out = (line: string) => void;

export type VetoAction = { action: "allow-once"; denied_ts: string; findings: FindingKey[]; expires: string } | { action: "allow-rule" | "deny-rule"; ruleId: string };

function record(root: string, now: Date, v: VetoAction): void {
  appendPrivate(join(root, VETO_DIR, LOG_FILE), JSON.stringify({ ts: now.toISOString(), veto: v }) + "\n");
}

function projectRoot(start: string, err: Out): string | null {
  const root = findVetoRoot(start);
  if (!root) err(`no Veto project here: no .veto folder in ${start} or any folder above it. Run this inside a project where you ran \`veto init\`.`);
  return root;
}

const clock = (d: Date) => formatTime(d.toISOString()).slice(11, 16);

/** The findings that denied a logged call. Older lines have no `because`: use the high ones, then all. */
function deniedBy(e: LogEntry): FindingKey[] {
  const pick = (fs: { ruleId?: unknown; reason?: unknown; severity?: unknown }[]) =>
    fs.filter((f) => typeof f.ruleId === "string" && typeof f.reason === "string").map((f) => ({ ruleId: f.ruleId as string, reason: f.reason as string }));
  if (Array.isArray(e.because) && e.because.length) return pick(e.because);
  const all = (e.findings ?? []) as { ruleId?: unknown; reason?: unknown; severity?: unknown }[];
  const high = all.filter((f) => f.severity === "high");
  return pick(high.length ? high : all);
}

export function allowOnce(start: string, out: Out, err: Out, now = new Date()): number {
  const root = projectRoot(start, err);
  if (!root) return 1;
  const logPath = join(root, VETO_DIR, LOG_FILE);
  const entries = existsSync(logPath) ? parseLog(readFileSync(logPath, "utf8")).entries : [];
  const last = [...entries].reverse().find((e) => e.event.hook_event_name === "PreToolUse" && e.decision === "denied");
  const findings = last ? deniedBy(last) : [];
  if (!last || findings.length === 0) {
    err(`nothing to allow: no denied call in ${logPath}.`);
    return 1;
  }
  const tool = typeof last.event.tool_name === "string" ? last.event.tool_name : null;
  const summary = summarizeInput(tool ?? undefined, last.event.tool_input);
  const expires = new Date(now.getTime() + ONCE_TTL_MS);
  const o: OnceOverride = { kind: "once", project: root, created: now.toISOString(), expires: expires.toISOString(), denied: { ts: last.ts, tool, summary }, findings };
  const replaced = readOverrideFile(root);
  writePrivate(overridePath(root), JSON.stringify(o, null, 2) + "\n");
  record(root, now, { action: "allow-once", denied_ts: last.ts, findings, expires: o.expires });
  if (replaced) out(`(replaced the earlier unused override for the call denied at ${formatTime(replaced.denied.ts)})`);
  out(`Allowed once, in ${root} only, until ${clock(expires)} (10 minutes):`);
  out(`  the next tool call whose blocking findings are all among these:`);
  for (const f of findings) out(`    [${f.ruleId}] ${f.reason}`);
  out(`  denied at ${formatTime(last.ts)}: ${tool ?? "?"} ${summary}`);
  out(`Now ask Claude to retry. The override is used up by that call, and expires at ${clock(expires)} if unused.`);
  return 0;
}

async function knownRule(ruleId: string, err: Out): Promise<boolean> {
  const ids = (await allRules()).map((r) => r.id).sort();
  if (ids.includes(ruleId)) return true;
  err(`unknown rule id: ${ruleId}\nRule ids: ${ids.join(", ")}`);
  return false;
}

/** `veto allow <ruleId>` (on = false: disable the rule) and `veto deny <ruleId>` (re-enable it). */
export async function setRule(start: string, ruleId: string, enable: boolean, out: Out, err: Out, now = new Date()): Promise<number> {
  const root = projectRoot(start, err);
  if (!root) return 1;
  if (!(await knownRule(ruleId, err))) return 1;
  const l = loadConfig(root);
  if (l.source === "invalid") {
    err(`not changing anything: ${l.error}. Fix or delete the file first.`);
    return 1;
  }
  const disabled = l.config.disabledRules.includes(ruleId);
  if (enable === !disabled) {
    out(enable ? `${ruleId} is already checked (not in disabledRules). Nothing changed.` : `${ruleId} is already disabled in ${configPath(root)}. Nothing changed.`);
    return 0;
  }
  const disabledRules = enable ? l.config.disabledRules.filter((r) => r !== ruleId) : [...l.config.disabledRules, ruleId];
  saveConfig(root, { ...l.config, disabledRules });
  record(root, now, { action: enable ? "deny-rule" : "allow-rule", ruleId });
  if (enable) out(`${ruleId} is checked again in this project (removed from disabledRules in ${configPath(root)}).`);
  else {
    out(`${ruleId} is disabled in this project (added to disabledRules in ${configPath(root)}).`);
    out(`  Veto no longer checks it here, in any mode. Undo with: veto deny ${ruleId}`);
  }
  return 0;
}
