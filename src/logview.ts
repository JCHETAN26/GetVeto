// `veto log [-n N]`: readable timeline of .veto/log.jsonl.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOG_FILE, VETO_DIR } from "./storage.js";

export interface LogEntry {
  ts: string;
  event: Record<string, unknown>;
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
  const tool = str(ev.tool_name) ?? "-";
  let summary = summarizeInput(str(ev.tool_name), ev.tool_input);
  if (eventName === "PostToolUseFailure" && typeof ev.error === "string") {
    summary += `  [error: ${oneLine(ev.error.split("\n")[0] ?? "", 60)}]`;
  }
  return `${formatTime(entry.ts)}  ${label}  ${tool.padEnd(10)}  ${summary}`;
}

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

export function showLog(root: string, n: number, out: (s: string) => void): number {
  const path = join(root, VETO_DIR, LOG_FILE);
  if (!existsSync(path)) {
    out(`No log yet at ${path}. Run \`veto init\` here, then use Claude Code in this folder.`);
    return 0;
  }
  const { entries, malformed } = parseLog(readFileSync(path, "utf8"));
  const shown = entries.slice(-n);
  if (shown.length === 0) out("(log is empty)");
  for (const e of shown) out(formatEntry(e));
  out(`-- ${shown.length} of ${entries.length} entries from ${path}${malformed ? ` (${malformed} malformed lines skipped)` : ""}`);
  return 0;
}
