// `veto doctor`: a quick health check of a Veto install in one project. It reports on Node's
// version, whether the hook is installed and points at a CLI that exists, whether the config is
// valid, and whether the log files are private, and prints a fix for anything wrong.
// Read-only: it never changes settings, config or logs.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfig } from "./config.js";
import { isVetoCliPath, LOCAL_SETTINGS, SHARED_SETTINGS } from "./install.js";
import { parseSettings, vetoHandlersIn, type CommandHandler } from "./settings.js";
import { LOG_FILE, VETO_DIR } from "./storage.js";

type Out = (line: string) => void;

const MIN_NODE_MAJOR = 22;
type Status = "ok" | "warn" | "fail";
interface Check {
  status: Status;
  title: string;
  /** Extra detail lines under the title. */
  detail?: string[];
  /** What to do about it (printed only for warn/fail). */
  fix?: string;
}

const MARK: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗" };

function checkNode(): Check {
  const v = process.versions.node;
  const major = Number(v.split(".")[0]);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) return { status: "ok", title: `Node ${v} (>= ${MIN_NODE_MAJOR})` };
  return {
    status: "fail",
    title: `Node ${v} is too old (Veto needs >= ${MIN_NODE_MAJOR})`,
    fix: `Install Node ${MIN_NODE_MAJOR} or newer (e.g. \`nvm install ${MIN_NODE_MAJOR}\`), then re-run \`veto init\` so the hook points at it.`,
  };
}

/** The CLI path a handler runs, or null for the portable `veto hook` (PATH) form. */
function cliPathOf(h: CommandHandler): string | null {
  if (h.command === "veto" || /^\s*veto\s+hook\s*$/.test(h.command)) return null;
  return Array.isArray(h.args) && typeof h.args[0] === "string" ? h.args[0] : null;
}

function readSettings(root: string, rel: string): Record<string, unknown> | null | "bad" {
  const abs = join(root, rel);
  if (!existsSync(abs)) return null;
  try {
    return parseSettings(readFileSync(abs, "utf8"));
  } catch {
    return "bad";
  }
}

function checkHook(root: string): Check {
  const found: { rel: string; handlers: CommandHandler[] }[] = [];
  const unreadable: string[] = [];
  for (const rel of [LOCAL_SETTINGS, SHARED_SETTINGS]) {
    const s = readSettings(root, rel);
    if (s === "bad") unreadable.push(rel);
    else if (s) {
      const handlers = vetoHandlersIn(s, isVetoCliPath);
      if (handlers.length) found.push({ rel, handlers });
    }
  }
  if (found.length === 0) {
    const detail = unreadable.map((r) => `${r} is not valid JSON, so Veto can't read it`);
    return {
      status: "fail",
      title: "Hook not installed in this project",
      detail: detail.length ? detail : undefined,
      fix: "Run `veto init --guard` (or `veto init` for watch mode) in this project.",
    };
  }
  const detail: string[] = [];
  let missing = false;
  let portable = false;
  for (const { rel, handlers } of found) {
    for (const h of handlers) {
      const cli = cliPathOf(h);
      if (cli === null) {
        portable = true;
        detail.push(`${rel}: runs \`veto hook\` from PATH`);
      } else if (existsSync(cli)) {
        detail.push(`${rel}: ${h.command} ${cli} hook`);
      } else {
        missing = true;
        detail.push(`${rel}: points at ${cli}, which does not exist`);
      }
    }
  }
  for (const r of unreadable) detail.push(`${r} is not valid JSON, so Veto can't read it`);
  if (missing) {
    return { status: "fail", title: "Hook points at a CLI that no longer exists", detail, fix: "Re-run `veto init` so the hook points at this install (paths change after `nvm use`, a reinstall, or a move)." };
  }
  if (portable) {
    return { status: "warn", title: "Hook installed (portable `veto hook` form)", detail, fix: "That form needs `veto` on PATH when Claude Code runs. If you launch it from the desktop or an IDE, re-run `veto init` for an absolute path." };
  }
  return { status: "ok", title: "Hook installed and points at an existing CLI", detail };
}

function checkConfig(root: string): Check {
  const l = loadConfig(root);
  const path = configPath(root);
  if (l.source === "invalid") return { status: "fail", title: "Config is invalid (Veto falls back to watch mode)", detail: [l.error ?? path], fix: `Fix or delete ${path}, then check \`veto mode\`.` };
  if (l.source === "default") return { status: "ok", title: `Config: defaults apply (no ${path})`, detail: [`mode ${l.config.mode}`] };
  return { status: "ok", title: `Config valid (${path})`, detail: [`mode ${l.config.mode}`] };
}

/** On POSIX, is this path readable only by its owner (mode 0o700/0o600)? */
function privateMode(path: string): boolean | null {
  if (process.platform === "win32") return null; // POSIX bits don't apply
  try {
    return (statSync(path).mode & 0o077) === 0;
  } catch {
    return null;
  }
}

function checkLog(root: string): Check {
  const dir = join(root, VETO_DIR);
  const log = join(dir, LOG_FILE);
  if (!existsSync(dir)) return { status: "ok", title: "No .veto folder yet (created on the first tool call)" };
  const leaky: string[] = [];
  for (const p of [dir, log]) if (existsSync(p) && privateMode(p) === false) leaky.push(p);
  if (leaky.length) return { status: "warn", title: "Log files are readable by other users", detail: leaky, fix: `Tighten permissions: \`chmod 700 ${dir}\` and \`chmod 600 ${log}\`. Veto re-tightens its own files when it writes.` };
  if (!existsSync(log)) return { status: "ok", title: "Log folder is private; no log yet" };
  return { status: "ok", title: "Log folder and file are private (owner only)" };
}

export function runDoctor(root: string, out: Out): number {
  const checks = [checkNode(), checkHook(root), checkConfig(root), checkLog(root)];
  out(`veto doctor — ${root}`);
  out("");
  for (const c of checks) {
    out(`${MARK[c.status]} ${c.title}`);
    for (const d of c.detail ?? []) out(`    ${d}`);
    if (c.status !== "ok" && c.fix) out(`    fix: ${c.fix}`);
  }
  out("");
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  if (fails) out(`${fails} problem${fails === 1 ? "" : "s"} to fix${warns ? `, ${warns} warning${warns === 1 ? "" : "s"}` : ""}.`);
  else if (warns) out(`No problems. ${warns} warning${warns === 1 ? "" : "s"} above.`);
  else out("All checks passed.");
  return fails ? 1 : 0;
}
