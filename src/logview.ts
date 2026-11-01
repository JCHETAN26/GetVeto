// `veto log [-n N] [--flagged] [--file <log.jsonl>]`: readable timeline of .veto/log.jsonl
// (or of a saved log file).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { LOG_FILE, VETO_DIR } from "./storage.js";

export interface LogFinding {
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

export function formatEntry(entry: LogEntry): string {
  const ev = entry.event;
  const eventName = str(ev.hook_event_name) ?? "?";
  const label = EVENT_LABEL[eventName] ?? eventName;
  if (eventName === "UserPromptSubmit") {
    return `${formatTime(entry.ts)}  ${label}  ${"prompt".padEnd(10)}  ${oneLine(str(ev.prompt) ?? "")}`;
  }
  const tool = str(ev.tool_name) ?? "-";
  let summary = summarizeInput(str(ev.tool_name), ev.tool_input);
  if (eventName === "PostToolUseFailure" && typeof ev.error === "string") {
    summary += `  [error: ${oneLine(ev.error.split("\n")[0] ?? "", 60)}]`;
  }
  return `${formatTime(entry.ts)}  ${label}  ${tool.padEnd(10)}  ${summary}${verdictSuffix(entry)}`;
}

/** "  ⚑ high: reason" for flagged lines (most severe finding first; the engine sorts them). */
export function verdictSuffix(entry: LogEntry): string {
  if (entry.verdict === "flag" && Array.isArray(entry.findings) && entry.findings.length > 0) {
    const [top, ...rest] = entry.findings;
    const more = rest.length > 0 ? ` (+${rest.length} more)` : "";
    return `  ⚑ ${top!.severity}: ${top!.reason}${more}`;
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
      } else malformed++;
    } catch {
      malformed++;
    }
  }
  return { entries, malformed };
}

export interface ShowLogOptions {
  flagged?: boolean;
  /** Read this saved log file (relative to root) instead of <root>/.veto/log.jsonl. */
  file?: string;
  /** Where errors go (default: out). */
  err?: (s: string) => void;
}

export function showLog(root: string, n: number, out: (s: string) => void, opts: ShowLogOptions = {}): number {
  let path: string;
  if (opts.file !== undefined) {
    path = resolve(root, opts.file);
    if (!existsSync(path) || !statSync(path).isFile()) {
      (opts.err ?? out)(`no log file at ${path}`);
      return 1;
    }
  } else {
    path = join(root, VETO_DIR, LOG_FILE);
    if (!existsSync(path)) {
      out(`No log yet at ${path}. Run \`veto init\` here, then use Claude Code in this folder.`);
      return 0;
    }
  }
  const { entries, malformed } = parseLog(readFileSync(path, "utf8"));
  const pool = opts.flagged ? entries.filter(isFlagged) : entries;
  const shown = pool.slice(-n);
  if (shown.length === 0) out(opts.flagged ? "(no flagged entries)" : "(log is empty)");
  for (const e of shown) out(formatEntry(e));
  const of = opts.flagged ? `${pool.length} flagged (${entries.length} total)` : `${entries.length}`;
  out(`-- ${shown.length} of ${of} entries from ${path}${malformed ? ` (${malformed} malformed lines skipped)` : ""}`);
  return 0;
}
