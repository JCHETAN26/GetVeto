// Path resolution + classification for shell arguments. Pure string logic: never touches the
// filesystem (no realpath), so it is fast and works for paths that don't exist yet.
import { homedir } from "node:os";
import { basename, isAbsolute, resolve, sep } from "node:path";

/** "unknown": the path isn't known statically (an unresolved argument, or relative to an unknown cwd). */
export type PathClass = "inside-project" | "outside-project" | "home" | "system" | "unknown";

/** A parsed argument (see shell/parse.ts Arg), or a plain literal path string. */
export type PathInput = string | { value: string; unresolved: boolean };

/**
 * Top-level directories owned by the OS (Linux + macOS). Anything at or below these is
 * "system". /tmp and /var/tmp are scratch space, so they count as "outside-project" instead.
 */
const SYSTEM_TOP = new Set([
  "bin", "boot", "dev", "etc", "lib", "lib32", "lib64", "libx32", "opt", "proc", "root", "run",
  "sbin", "srv", "sys", "usr", "var", "snap", "home", "Users",
  "System", "Library", "Applications", "private", "Volumes", "cores",
]);
const SCRATCH = ["/tmp", "/var/tmp", "/private/tmp"];

const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * Where ~user lives. Only your own user name maps to `home`; other users get a stand-in
 * under /home/<user> (or /Users on macOS), which classifies as system. We don't read
 * /etc/passwd: the path is for classification, not for access.
 */
function userHome(user: string, home: string): string {
  if (user === basename(home)) return home;
  return resolve(home, "..", user).startsWith("/Users/") ? `/Users/${user}` : `/home/${user}`;
}

/** Expand ~, ~/, ~user and ~user/, and resolve against cwd, normalizing . and .. segments. */
export function resolvePath(path: string, cwd: string, home: string = homedir()): string {
  let p = path;
  const m = /^~([A-Za-z0-9._-]*)(\/.*)?$/.exec(p);
  if (m) p = (m[1] ? userHome(m[1], home) : home) + (m[2] ?? "");
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/**
 * Classify a path argument. Precedence: unknown, inside-project, home (your home directory
 * or anything under it, outside the project), system, else outside-project.
 * `~otheruser/...` is another user's home, which is system.
 * Pass a parsed Arg to get "unknown" for unresolved arguments ($VAR, globs, {a,b}, $(...));
 * a plain string is taken literally. cwd = null (unknown) makes relative paths unknown.
 */
export function classifyPath(path: PathInput, cwd: string | null, projectRoot: string, home: string = homedir()): PathClass {
  const value = typeof path === "string" ? path : path.value;
  if (typeof path !== "string" && path.unresolved) return "unknown";
  if (cwd === null && !isAbsolute(value) && !value.startsWith("~")) return "unknown";
  const abs = resolvePath(value, cwd ?? "/", home);
  const root = resolve(projectRoot);
  if (within(abs, root)) return "inside-project";
  const h = resolve(home);
  if (h !== "/" && within(abs, h)) return "home";
  if (SCRATCH.some((d) => within(abs, d))) return "outside-project";
  if (abs === "/") return "system";
  const top = abs.split(sep)[1] ?? "";
  return SYSTEM_TOP.has(top) ? "system" : "outside-project";
}
