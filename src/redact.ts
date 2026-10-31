// Redaction used by scripts/capture-fixtures.mjs before real payloads go into the repo.
// Best-effort: it catches common secret formats and home-directory paths. It is NOT a
// guarantee, so review fixtures before committing them.

export const HOME_PLACEHOLDER = "/home/REDACTED_USER";
export const SECRET_PLACEHOLDER = "[REDACTED_SECRET]";

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, // Anthropic / OpenAI style
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/g, // creds in URLs
];

// KEY=value / "key": "value" style assignments where the key name looks sensitive.
const ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|access[_-]?key|auth)[A-Za-z0-9_]*)(["']?\s*[:=]\s*)(["']?)([^\s"'`]{6,})\3/gi;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RedactOptions {
  homeDir: string;
  username?: string;
}

export function redactString(s: string, opts: RedactOptions): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, SECRET_PLACEHOLDER);
  out = out.replace(ASSIGNMENT, (_m, key: string, sep: string, q: string) => `${key}${sep}${q}${SECRET_PLACEHOLDER}${q}`);
  if (opts.homeDir && opts.homeDir !== "/") {
    out = out.replace(new RegExp(escapeRegex(opts.homeDir) + "(?=$|[/\\\\])", "g"), HOME_PLACEHOLDER);
    // Claude Code encodes project paths into dir names, e.g. ~/.claude/projects/-home-alice-proj
    const dashed = opts.homeDir.replace(/[\\/]/g, "-");
    out = out.replace(new RegExp(escapeRegex(dashed) + "(?=$|-)", "g"), "-home-REDACTED_USER");
  }
  if (opts.username && opts.username.length >= 3) {
    out = out.replace(new RegExp(`\\b${escapeRegex(opts.username)}\\b`, "g"), "REDACTED_USER");
  }
  return out;
}

/** Deep-redact every string (keys and values) in a JSON value. */
export function redactValue(v: unknown, opts: RedactOptions): unknown {
  if (typeof v === "string") return redactString(v, opts);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, opts));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[redactString(k, opts)] = redactValue(val, opts);
    return out;
  }
  return v;
}

export const PROJECT_PLACEHOLDER = "/REDACTED_PROJECT";

export interface RedactEventOptions extends RedactOptions {
  /** Absolute project path; replaced by PROJECT_PLACEHOLDER (it reveals the machine's layout). */
  projectDir?: string;
}

/**
 * Full redaction used for anything that leaves .veto/ (fixtures, labeled examples):
 * per-string redaction, project path -> placeholder, then a second pass over the serialized
 * JSON that catches secrets split across a key and its value (e.g. {"password": "..."}).
 * The second pass is kept only if the result is still valid JSON.
 */
export function redactEvent(value: unknown, opts: RedactEventOptions): { value: unknown; secondPassApplied: boolean } {
  let text = JSON.stringify(redactValue(value, opts));
  if (opts.projectDir) {
    const raw = JSON.stringify(opts.projectDir).slice(1, -1);
    const redacted = JSON.stringify(redactString(opts.projectDir, opts)).slice(1, -1);
    text = text.split(raw).join(PROJECT_PLACEHOLDER).split(redacted).join(PROJECT_PLACEHOLDER);
    // Claude Code also encodes the project path into folder names (transcript_path,
    // scratchpad_dir) by turning every non-alphanumeric character into "-".
    const dashed = opts.projectDir.replace(/[^A-Za-z0-9]/g, "-");
    const dashedRedacted = redactString(dashed, opts);
    for (const d of [dashed, dashedRedacted]) if (d.length > 1) text = text.split(d).join("-REDACTED_PROJECT");
  }
  const second = redactString(text, opts);
  try {
    return { value: JSON.parse(second), secondPassApplied: true };
  } catch {
    return { value: JSON.parse(text), secondPassApplied: false };
  }
}
