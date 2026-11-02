// `veto log [-n N] [--flagged] [--file <log.jsonl>]`: readable timeline of .veto/log.jsonl
// (or of a saved log file).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { findVetoRoot, LOG_FILE, VETO_DIR } from "./storage.js";

export interface LogFinding {
  ruleId?: string;
  severity: string;
  reason: string;
}

export interface LogEntry {
  ts: string;
  event: Record<string, unknown>;
  /** Watch mode (PreToolUse only): "allow" | "flag" | "error". */
  verdict?: string;
  findings?: LogFinding[];
  error?: string;
  /** What the hook did (guard mode can ask or deny). Older entries don't have it. */
  decision?: "allowed" | "asked" | "denied";
  /** Asked/denied: the findings that caused it. */
  because?: { ruleId: string; reason: string }[];
  /** A `veto allow --once` override was used up on this call. */
  override?: { kind: string; granted?: string; findings?: { ruleId: string; reason: string }[] };
  /**
   * Written by the user's own `veto allow` / `veto deny`, not by a Claude Code event. Such lines
   * have no "event" in the file; parseLog gives them an empty one.
   */
  veto?: { action: string; ruleId?: string; findings?: { ruleId: string; reason: string }[]; expires?: string; denied_ts?: string };
}

const MAX_SUMMARY = 100;

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function oneLine(s: string, max = MAX_SUMMARY): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** One-line summary of a tool call's input. Unknown tools fall back to compact JSON. */
export function summarizeInput(toolName: string | undefined, input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  switch (toolName) {
    case "Bash":
    case "PowerShell":
      return oneLine(str(i.command) ?? "");
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return oneLine(str(i.file_path) ?? str(i.notebook_path) ?? "");
    case "Glob":
      return oneLine([str(i.pattern), str(i.path) && `in ${str(i.path)}`].filter(Boolean).join(" "));
    case "Grep":
      return oneLine([JSON.stringify(i.pattern ?? ""), str(i.path) && `in ${str(i.path)}`].filter(Boolean).join(" "));
    case "WebFetch":
      return oneLine(str(i.url) ?? "");
    case "WebSearch":
      return oneLine(str(i.query) ?? "");
    case "Agent":
    case "Task":
      return oneLine(str(i.description) ?? str(i.prompt) ?? "");
    default: {
      const firstString = Object.values(i).find((v): v is string => typeof v === "string");
      return oneLine(firstString ?? JSON.stringify(i));
    }
  }
}

const EVENT_LABEL: Record<string, string> = {
  PreToolUse: "pre ",
  PostToolUse: "post",
  PostToolUseFailure: "FAIL",
  UserPromptSubmit: "user",
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

function formatVeto(entry: LogEntry): string {
  const v = entry.veto!;
  const head = `${formatTime(entry.ts)}  you   ${"veto".padEnd(10)}  `;
  if (v.action === "allow-once") {
    const what = (v.findings ?? []).map((f) => f.ruleId).join(", ");
    return `${head}allow --once (${what}) for the call denied at ${formatTime(v.denied_ts ?? "")}, until ${v.expires ? formatTime(v.expires).slice(11, 16) : "?"}`;
  }
  if (v.action === "allow-rule") return `${head}allow ${v.ruleId}: rule disabled in this project`;
  if (v.action === "deny-rule") return `${head}deny ${v.ruleId}: rule checked again`;
  return `${head}${v.action}`;
}

export interface FormatOptions {
  /** Every finding on its own line under the entry, instead of "(+N more)". */
  verbose?: boolean;
}

export function formatEntry(entry: LogEntry, opts: FormatOptions = {}): string {
  if (entry.veto) return formatVeto(entry);
  const ev = entry.event;
  const eventName = str(ev.hook_event_name);
  if (eventName === undefined) {
    // Not something Claude Code sends (every hook payload names its event), e.g. `echo '{}' | veto hook`
    // run by hand. Say so, and list the field names (never values) so it can be traced.
    const fields = Object.keys(ev);
    return `${formatTime(entry.ts)}  (no event name)  ${fields.length ? `fields: ${oneLine(fields.join(", "), 80)}` : "empty payload {}"}`;
  }
  // Events without a short label (new or rare ones) print their own name.
  const label = EVENT_LABEL[eventName] ?? eventName;
  if (eventName === "UserPromptSubmit") {
    return `${formatTime(entry.ts)}  ${label}  ${"prompt".padEnd(10)}  ${oneLine(str(ev.prompt) ?? "")}`;
  }
  const tool = str(ev.tool_name) ?? "-";
  let summary = summarizeInput(str(ev.tool_name), ev.tool_input);
  if (eventName === "PostToolUseFailure" && typeof ev.error === "string") {
    summary += `  [error: ${oneLine(ev.error.split("\n")[0] ?? "", 60)}]`;
  }
  const line = `${formatTime(entry.ts)}  ${label}  ${tool.padEnd(10)}  ${summary}${verdictSuffix(entry, opts)}`;
  if (!opts.verbose || entry.verdict !== "flag" || !Array.isArray(entry.findings)) return line;
  const details = entry.findings.map((f) => `      ${f.severity.padEnd(6)} ${f.ruleId ? `${f.ruleId}: ` : ""}${f.reason}`);
  return [line, ...details].join("\n");
}

/**
 * Marker for flagged lines, most severe finding first (the engine sorts them):
 * "  ⛔ denied high: reason" / "  ? asked medium: reason" in guard mode, "  ⚑ high: reason" otherwise.
 */
export function verdictSuffix(entry: LogEntry, opts: FormatOptions = {}): string {
  if (entry.verdict === "flag" && Array.isArray(entry.findings) && entry.findings.length > 0) {
    const [top, ...rest] = entry.findings;
    // --verbose lists every finding on the lines below instead.
    const more = rest.length > 0 && !opts.verbose ? ` (+${rest.length} more)` : "";
    const mark = entry.decision === "denied" ? "⛔ denied " : entry.decision === "asked" ? "? asked " : entry.override ? "✓ allowed once by you, " : "⚑ ";
    return `  ${mark}${top!.severity}: ${top!.reason}${more}`;
  }
  if (entry.verdict === "error") return `  ⚠ analysis error: ${oneLine(entry.error ?? "", 60)}`;
  return "";
}

export const isFlagged = (e: LogEntry) => e.verdict === "flag";

export interface ParsedLog {
  entries: LogEntry[];
  malformed: number;
}

export function parseLog(text: string): ParsedLog {
  const entries: LogEntry[] = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v = JSON.parse(line) as Partial<LogEntry>;
      if (typeof v.ts === "string" && v.event && typeof v.event === "object") {
        entries.push(v as LogEntry);
      } else if (typeof v.ts === "string" && v.veto && typeof v.veto === "object" && typeof v.veto.action === "string") {
        entries.push({ ...(v as LogEntry), event: {} });
      } else malformed++;
    } catch {
      malformed++;
    }
  }
  return { entries, malformed };
}

export interface ShowLogOptions {
  flagged?: boolean;
  verbose?: boolean;
  /** Read this saved log file (relative to cwd) instead of the project's .veto/log.jsonl. */
  file?: string;
  /** Where errors go (default: out). */
  err?: (s: string) => void;
}

/**
 * Without --file, the log is the one in the nearest .veto folder at or above `cwd` (like git
 * finds .git), so `veto log` works from any subfolder of the project.
 */
export function showLog(cwd: string, n: number, out: (s: string) => void, opts: ShowLogOptions = {}): number {
  let path: string;
  if (opts.file !== undefined) {
    path = resolve(cwd, opts.file);
    if (!existsSync(path) || !statSync(path).isFile()) {
      (opts.err ?? out)(`no log file at ${path}`);
      return 1;
    }
  } else {
    const root = findVetoRoot(cwd);
    if (root === null) {
      out(`No Veto log found in ${resolve(cwd)} or any folder above it. Run \`veto log\` inside a project where you ran \`veto init\`, or use --file <log.jsonl>.`);
      return 0;
    }
    path = join(root, VETO_DIR, LOG_FILE);
    if (!existsSync(path)) {
      out(`No log yet at ${path}. Use Claude Code in ${root} and its tool calls will show up here.`);
      return 0;
    }
  }
  const { entries, malformed } = parseLog(readFileSync(path, "utf8"));
  const pool = opts.flagged ? entries.filter(isFlagged) : entries;
  const shown = pool.slice(-n);
  if (shown.length === 0) out(opts.flagged ? "(no flagged entries)" : "(log is empty)");
  for (const e of shown) out(formatEntry(e, { verbose: opts.verbose }));
  const of = opts.flagged ? `${pool.length} flagged (${entries.length} total)` : `${entries.length}`;
  out(`-- ${shown.length} of ${of} entries from ${path}${malformed ? ` (${malformed} malformed lines skipped)` : ""}`);
  return 0;
}
