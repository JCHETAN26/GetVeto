// Read / Write / Edit on files whose path looks like it holds secrets: .env files (not the
// example/sample/template ones), *.pem, *.key, SSH keys, anything under ~/.ssh.
import { basename, sep } from "node:path";
import { resolvePath } from "../../shell/paths.js";
import type { Rule } from "../types.js";
import { toolPath } from "./outside-project.js";

const ID = "file-tools/secret-path";
const TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit"]);
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);

/** Why this path looks like a secret, or null. */
export function secretLooking(path: string, cwd: string | null, home: string): string | null {
  const abs = resolvePath(path, cwd ?? "/", home);
  const name = basename(abs);
  const ssh = resolvePath("~/.ssh", "/", home);
  if (abs === ssh || abs.startsWith(ssh + sep)) return "a file under ~/.ssh";
  if ((name === ".env" || name.startsWith(".env.")) && !ENV_TEMPLATES.has(name)) return "an .env file";
  if (name.endsWith(".pem") || name.endsWith(".key")) return "a key or certificate file";
  if (name.startsWith("id_rsa") || name.startsWith("id_ed25519")) return "an SSH key file";
  return null;
}

export const secretPath: Rule = {
  id: ID,
  category: "file-tools",
  check(ctx) {
    if (!ctx.toolName || !TOOLS.has(ctx.toolName)) return [];
    const path = toolPath(ctx);
    if (!path) return [];
    const why = secretLooking(path, ctx.cwd, ctx.home);
    if (!why) return [];
    return [{ ruleId: ID, category: "file-tools", severity: "medium", reason: `${ctx.toolName} on ${why}, which may hold secrets: ${basename(path)}.` }];
  },
};
