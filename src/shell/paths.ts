// Path resolution + classification for shell arguments. Pure string logic: never touches the
// filesystem (no realpath), so it is fast and works for paths that don't exist yet.
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

export type PathClass = "inside-project" | "outside-project" | "home" | "system";

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

/** Expand a leading ~ or ~/ and resolve against cwd, normalizing . and .. segments. */
export function resolvePath(path: string, cwd: string, home: string = homedir()): string {
  let p = path;
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = home + p.slice(1);
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/**
 * Classify a path argument. Precedence: inside-project, then home (your home directory or
 * anything under it, outside the project), then system, else outside-project.
 * `~user/...` is not expanded (it's resolved as a relative name).
 */
export function classifyPath(path: string, cwd: string, projectRoot: string, home: string = homedir()): PathClass {
  const abs = resolvePath(path, cwd, home);
  const root = resolve(projectRoot);
  if (within(abs, root)) return "inside-project";
  const h = resolve(home);
  if (h !== "/" && within(abs, h)) return "home";
  if (SCRATCH.some((d) => within(abs, d))) return "outside-project";
  if (abs === "/") return "system";
  const top = abs.split(sep)[1] ?? "";
  return SYSTEM_TOP.has(top) ? "system" : "outside-project";
}
