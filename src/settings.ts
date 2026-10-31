// Pure merge logic for Claude Code settings files. No filesystem access here.
// Format reference: docs/hooks-research.md §4.

export const VETO_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure"] as const;

/** Seconds. Claude Code's default is 600; we cap a hung Veto at 10s. */
export const VETO_HOOK_TIMEOUT_S = 10;

export interface CommandHandler {
  type: "command";
  command: string;
  args?: string[];
  timeout?: number;
  [k: string]: unknown;
}

/** The exact handler Veto installs. Exec form: no shell, so paths with spaces are safe. */
export function vetoHandler(): CommandHandler {
  return { type: "command", command: "veto", args: ["hook"], timeout: VETO_HOOK_TIMEOUT_S };
}

export function isVetoHandler(h: unknown): boolean {
  if (!isPlainObject(h)) return false;
  if (h.type !== "command") return false;
  const args = h.args;
  if (h.command === "veto" && Array.isArray(args) && args[0] === "hook") return true;
  // Also recognize a shell-form spelling someone may have written by hand.
  return typeof h.command === "string" && /^\s*veto\s+hook\s*$/.test(h.command) && args === undefined;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export class SettingsShapeError extends Error {}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export interface MergeResult {
  settings: Record<string, unknown>;
  /** Events Veto was added to (empty = nothing changed). */
  added: string[];
}

/** Add Veto's handler to each event that doesn't already have one. Never removes anything. */
export function addVetoHooks(input: Record<string, unknown>): MergeResult {
  const settings = clone(input);
  if (settings.hooks !== undefined && !isPlainObject(settings.hooks)) {
    throw new SettingsShapeError(`"hooks" must be an object, found ${typeof settings.hooks}`);
  }
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const added: string[] = [];

  for (const event of VETO_EVENTS) {
    const groups = hooks[event];
    if (groups !== undefined && !Array.isArray(groups)) {
      throw new SettingsShapeError(`"hooks.${event}" must be an array`);
    }
    const list = (groups ?? []) as unknown[];
    const present = list.some(
      (g) => isPlainObject(g) && Array.isArray(g.hooks) && g.hooks.some(isVetoHandler),
    );
    if (present) continue;
    list.push({ matcher: "*", hooks: [vetoHandler()] });
    hooks[event] = list;
    added.push(event);
  }

  if (added.length > 0) settings.hooks = hooks;
  return { settings, added };
}

export interface RemoveResult {
  settings: Record<string, unknown>;
  /** Number of Veto handlers removed, per event. */
  removed: Record<string, number>;
  changed: boolean;
}

/**
 * Remove every Veto handler (any event). Matcher groups / event arrays / the hooks object are
 * deleted only if Veto's removal left them empty. Everything else is left exactly as found.
 */
export function removeVetoHooks(input: Record<string, unknown>): RemoveResult {
  const settings = clone(input);
  const removed: Record<string, number> = {};
  if (!isPlainObject(settings.hooks)) return { settings, removed, changed: false };
  const hooks = settings.hooks;

  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    let count = 0;
    const kept: unknown[] = [];
    for (const g of groups) {
      if (!isPlainObject(g) || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const before = g.hooks.length;
      const remaining = g.hooks.filter((h) => !isVetoHandler(h));
      const n = before - remaining.length;
      if (n === 0) {
        kept.push(g);
        continue;
      }
      count += n;
      if (remaining.length > 0) kept.push({ ...g, hooks: remaining });
      // else: the group only held Veto handlers -> drop it.
    }
    if (count > 0) {
      removed[event] = count;
      if (kept.length > 0) hooks[event] = kept;
      else delete hooks[event];
    }
  }

  const changed = Object.keys(removed).length > 0;
  if (changed && Object.keys(hooks).length === 0) delete settings.hooks;
  return { settings, removed, changed };
}

export function containsVeto(settings: Record<string, unknown>): boolean {
  return removeVetoHooks(settings).changed;
}

export function serializeSettings(settings: Record<string, unknown>): string {
  return JSON.stringify(settings, null, 2) + "\n";
}

/** Parse a settings file's text. Empty/whitespace file is treated as {}. */
export function parseSettings(text: string): Record<string, unknown> {
  if (text.trim() === "") return {};
  const v = JSON.parse(text) as unknown;
  if (!isPlainObject(v)) throw new SettingsShapeError("settings file must contain a JSON object");
  return v;
}

/** True if a .gitignore already ignores `entry` (simple line match, ignores comments). */
export function gitignoreHas(text: string, entry: string): boolean {
  const norm = (s: string) => s.trim().replace(/^\//, "").replace(/\/$/, "");
  const want = norm(entry);
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .some((l) => norm(l) === want);
}

export function gitignoreAppend(text: string, entries: string[]): string {
  let out = text;
  if (out !== "" && !out.endsWith("\n")) out += "\n";
  for (const e of entries) out += e + "\n";
  return out;
}
