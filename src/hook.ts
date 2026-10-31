// `veto hook`: invoked by Claude Code for PreToolUse / PostToolUse / PostToolUseFailure.
//
// Contract (see docs/hooks-research.md):
//   - Read one JSON object from stdin.
//   - Append {"ts", "event"} as one line to <project>/.veto/log.jsonl.
//   - "Allow" in observe-only mode = exit 0 with EMPTY stdout (no decision; Claude Code's
//     normal permission flow applies). We never print permissionDecision:"allow", which
//     would auto-approve the call.
//   - Fail open: any error is written to .veto/errors.log (or stderr as last resort) and we
//     still exit 0 with empty stdout. We never exit 2 and never hang.
import { join } from "node:path";
import { appendPrivate, ensureVetoDir, ERROR_FILE, LOG_FILE } from "./storage.js";

/** Hard ceiling on how long we wait for stdin before giving up and allowing. */
export const STDIN_TIMEOUT_MS = 2000;
/** Refuse to buffer absurdly large payloads (protects memory; still allows). */
export const MAX_STDIN_BYTES = 32 * 1024 * 1024;

export interface ParseResult {
  ok: boolean;
  event?: Record<string, unknown>;
  error?: string;
}

/** Parse the hook payload. Must be a single JSON object. */
export function parseEvent(raw: string): ParseResult {
  if (raw.trim() === "") return { ok: false, error: "empty stdin" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "payload is not a JSON object" };
  }
  return { ok: true, event: value as Record<string, unknown> };
}

/**
 * Where .veto/ lives. CLAUDE_PROJECT_DIR is the project root where the session started and
 * does not move when Claude cd's around, so it wins. Then the event's cwd, then our cwd.
 */
export function resolveProjectRoot(
  env: NodeJS.ProcessEnv,
  event: Record<string, unknown> | undefined,
  fallbackCwd: string,
): string {
  const fromEnv = env.CLAUDE_PROJECT_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
  const fromEvent = event?.cwd;
  if (typeof fromEvent === "string" && fromEvent.trim() !== "") return fromEvent;
  return fallbackCwd;
}

export function formatLogLine(event: Record<string, unknown>, now: Date): string {
  return JSON.stringify({ ts: now.toISOString(), event }) + "\n";
}

function recordError(root: string, message: string): void {
  const line = `${new Date().toISOString()} ${message.replace(/\s+/g, " ").slice(0, 2000)}\n`;
  try {
    const dir = ensureVetoDir(root);
    appendPrivate(join(dir, ERROR_FILE), line);
  } catch (e) {
    // Last resort. Claude Code never shows stderr of an exit-0 hook to Claude; it goes to
    // the debug log (claude --debug).
    try {
      process.stderr.write(`veto: ${line}veto: also failed to write errors.log: ${(e as Error).message}\n`);
    } catch {
      /* nothing left to do */
    }
  }
}

/** Process a raw stdin string. Never throws. */
export function handlePayload(raw: string, env: NodeJS.ProcessEnv, cwd: string): void {
  let root = cwd;
  try {
    const parsed = parseEvent(raw);
    root = resolveProjectRoot(env, parsed.event, cwd);
    if (!parsed.ok || !parsed.event) {
      const preview = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
      recordError(root, `hook: ${parsed.error}; stdin preview: ${JSON.stringify(preview)}`);
      return;
    }
    const dir = ensureVetoDir(root);
    appendPrivate(join(dir, LOG_FILE), formatLogLine(parsed.event, new Date()));
  } catch (e) {
    recordError(root, `hook: ${(e as Error)?.stack ?? String(e)}`);
  }
}

/** Entry point for `veto hook`. Always ends the process with exit 0 and empty stdout. */
export function runHook(): void {
  const env = process.env;
  const cwd = process.cwd();
  let done = false;
  const chunks: Buffer[] = [];
  let size = 0;

  const finish = (raw: string | null, error?: string) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (raw === null) {
      recordError(resolveProjectRoot(env, undefined, cwd), `hook: ${error}`);
    } else {
      handlePayload(raw, env, cwd);
    }
    process.exit(0);
  };

  const timer = setTimeout(
    () => finish(null, `stdin not closed within ${STDIN_TIMEOUT_MS}ms; allowing`),
    STDIN_TIMEOUT_MS,
  );

  process.on("uncaughtException", (e) => finish(null, `uncaught: ${e?.stack ?? String(e)}`));

  const stdin = process.stdin;
  stdin.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) {
      finish(null, `stdin exceeded ${MAX_STDIN_BYTES} bytes; not logged`);
      return;
    }
    chunks.push(chunk);
  });
  stdin.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
  stdin.on("error", (e) => finish(null, `stdin error: ${e.message}`));
}
