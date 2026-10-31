// Size cap for logged events. Runs on the hook hot path, so keep it dependency-free.
//
// Any string inside tool_input / tool_response longer than MAX_BYTES (UTF-8) keeps its first
// MAX_BYTES bytes and gets a marker appended with the original byte length and the sha256 of
// the full value. The shell `command` of Bash/PowerShell gets a larger cap (COMMAND_MAX_BYTES),
// because the command is what matters most for judging an action.
import { createRequire } from "node:module";

// node:crypto costs ~3 ms to load, and almost no hook call needs it. Load it only on the first
// truncation. process.getBuiltinModule exists on Node >= 20.16 / 22.3; createRequire otherwise.
type CryptoModule = typeof import("node:crypto");
let cryptoMod: CryptoModule | undefined;
function sha256Hex(buf: Buffer): string {
  if (!cryptoMod) {
    const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    cryptoMod = (getBuiltin?.("node:crypto") ?? createRequire(import.meta.url)("node:crypto")) as CryptoModule;
  }
  return cryptoMod.createHash("sha256").update(buf).digest("hex");
}

export const MAX_BYTES = 4 * 1024;
export const COMMAND_MAX_BYTES = 16 * 1024;
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

export function truncationMarker(originalBytes: number, sha256: string): string {
  return `…[veto:truncated original_bytes=${originalBytes} sha256=${sha256}]`;
}

/** Matches a marker produced by truncationMarker(). */
export const TRUNCATION_MARKER_RE = /…\[veto:truncated original_bytes=(\d+) sha256=([0-9a-f]{64})\]$/;

/** First `max` bytes of `s` as UTF-8, never splitting a multi-byte character. */
function headBytes(buf: Buffer, max: number): string {
  let end = max;
  // Back off continuation bytes (10xxxxxx) so we cut on a character boundary.
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

export function truncateString(s: string, max: number): { value: string; truncated: boolean } {
  // Fast path: a JS string's UTF-8 length is at most 3 bytes per UTF-16 unit.
  if (s.length * 3 <= max) return { value: s, truncated: false };
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return { value: s, truncated: false };
  const sha = sha256Hex(buf);
  return { value: headBytes(buf, max) + truncationMarker(buf.length, sha), truncated: true };
}

function walk(v: unknown, path: string, limitFor: (path: string) => number, hits: string[]): unknown {
  if (typeof v === "string") {
    const r = truncateString(v, limitFor(path));
    if (r.truncated) hits.push(path);
    return r.value;
  }
  if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`, limitFor, hits));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = walk(val, `${path}.${k}`, limitFor, hits);
    return out;
  }
  return v;
}

export interface TruncateResult {
  event: Record<string, unknown>;
  /** JSON-ish paths of the strings that were truncated, e.g. "tool_response.file.content". */
  truncated: string[];
}

/**
 * Returns a size-capped copy of the event. Only tool_input, tool_response and a
 * UserPromptSubmit `prompt` are capped; every other field is untouched.
 */
export function truncateEvent(event: Record<string, unknown>): TruncateResult {
  const hits: string[] = [];
  const shell = typeof event.tool_name === "string" && SHELL_TOOLS.has(event.tool_name);
  const limitFor = (p: string) => (shell && p === "tool_input.command" ? COMMAND_MAX_BYTES : MAX_BYTES);
  let out = event;
  // A pasted prompt can be huge; keep up to 16 KB of it (same allowance as a shell command).
  if (typeof event.prompt === "string") {
    const r = truncateString(event.prompt, COMMAND_MAX_BYTES);
    if (r.truncated) {
      out = { ...event, prompt: r.value };
      hits.push("prompt");
    }
  }
  for (const key of ["tool_input", "tool_response"] as const) {
    if (!(key in event)) continue;
    const before = hits.length;
    const value = walk(event[key], key, limitFor, hits);
    if (hits.length > before) {
      if (out === event) out = { ...event };
      out[key] = value;
    }
  }
  return { event: out, truncated: hits };
}
