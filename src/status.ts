// `veto mode [watch|guard]` and `veto status`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfig, saveConfig, type Mode } from "./config.js";
import { isVetoCliPath, LOCAL_SETTINGS, SHARED_SETTINGS } from "./install.js";
import { formatEntry, formatTime, isFlagged, parseLog } from "./logview.js";
import { containsVeto, parseSettings } from "./settings.js";
import { activeOnce, readOverrideFile } from "./override.js";
import { ensureVetoDir, LOG_FILE, VETO_DIR } from "./storage.js";

type Out = (line: string) => void;

const DESCRIBE: Record<Mode, string> = {
  watch: "watch: flags risky calls in the log, never blocks",
  guard: "guard: acts on findings by severity",
};

export function showMode(root: string, out: Out): number {
  const l = loadConfig(root);
  if (l.source === "invalid") {
    out(`mode: watch (config is invalid, so Veto falls back to watch mode)`);
    out(`  ${l.error}`);
    return 0;
  }
  out(`mode: ${DESCRIBE[l.config.mode]}${l.source === "default" ? ` (default; no ${configPath(root)})` : ""}`);
  if (l.config.mode === "guard") {
    const a = l.config.actions;
    out(`  high -> ${a.high}, medium -> ${a.medium}, low -> ${a.low}`);
  }
  if (l.config.disabledRules.length) out(`  disabled rules: ${l.config.disabledRules.join(", ")}`);
  return 0;
}

export function setMode(root: string, mode: Mode, out: Out, err: Out): number {
  const l = loadConfig(root);
  if (l.source === "invalid") {
    err(`not changing the mode: ${l.error}. Fix or delete the file first.`);
    return 1;
  }
  if (l.source === "file" && l.config.mode === mode) {
    out(`mode is already ${mode}. Nothing changed.`);
    return 0;
  }
  ensureVetoDir(root);
  const before = l.config.mode;
  saveConfig(root, { ...l.config, mode });
  out(`mode: ${before} -> ${mode}  (${configPath(root)})`);
  out(`  ${DESCRIBE[mode]}. Takes effect on Claude Code's next tool call; no restart needed.`);
  return 0;
}

function hookState(root: string, rel: string): string {
  const abs = join(root, rel);
  if (!existsSync(abs)) return "no file";
  try {
    return containsVeto(parseSettings(readFileSync(abs, "utf8")), isVetoCliPath) ? "installed" : "not installed";
  } catch {
    return "unreadable (not valid JSON)";
  }
}

export function showStatus(root: string, out: Out): number {
  showMode(root, out);
  out(`hook:`);
  out(`  ${LOCAL_SETTINGS.padEnd(28)} ${hookState(root, LOCAL_SETTINGS)}`);
  out(`  ${SHARED_SETTINGS.padEnd(28)} ${hookState(root, SHARED_SETTINGS)}`);
  out(`config: ${configPath(root)}${existsSync(configPath(root)) ? "" : " (not created yet; defaults apply)"}`);
  const once = readOverrideFile(root);
  if (once) {
    const live = activeOnce(root, new Date()) !== null;
    out(`override: allow --once ${live ? "pending" : "expired or not for this project"} (${once.findings.map((f) => f.ruleId).join(", ")}; expires ${formatTime(once.expires)})`);
  }
  const logPath = join(root, VETO_DIR, LOG_FILE);
  if (!existsSync(logPath)) {
    out(`log: none yet at ${logPath}`);
    return 0;
  }
  const { entries } = parseLog(readFileSync(logPath, "utf8"));
  const flagged = entries.filter(isFlagged);
  out(`log: ${logPath} (${entries.length} entries, ${flagged.length} flagged)`);
  const last = flagged.slice(-5);
  if (last.length === 0) out("last flags: none");
  else {
    out(`last ${last.length} flag${last.length === 1 ? "" : "s"}:`);
    for (const e of last) out(`  ${formatEntry(e)}`);
  }
  return 0;
}
