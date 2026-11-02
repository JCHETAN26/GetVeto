// Read / Write / Edit on files whose path looks like it holds secrets (the shared list in
// ../secret-paths.ts: .env files, keys, ~/.ssh, credential files).
import { basename } from "node:path";
import { secretLooking } from "../secret-paths.js";
import type { Rule } from "../types.js";
import { toolPath } from "./outside-project.js";

const ID = "file-tools/secret-path";
const TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit"]);

export const secretPath: Rule = {
  id: ID,
  category: "file-tools",
  check(ctx) {
    if (!ctx.toolName || !TOOLS.has(ctx.toolName)) return [];
    const path = toolPath(ctx);
    if (!path) return [];
    const why = secretLooking(path, ctx.cwd, ctx.home);
    if (!why) return [];
    return [
      {
        ruleId: ID,
        category: "file-tools",
        severity: "medium",
        reason: `${ctx.toolName} on ${why}, which may hold secrets: ${basename(path)}.`,
        suggestion: "Use a template such as .env.example, or ask the user for the specific value you need.",
      },
    ];
  },
};
