// Write / Edit / MultiEdit / NotebookEdit to a file outside the project.
// Field names: file_path is documented for Write and Edit (docs/hooks-research.md). For
// MultiEdit and NotebookEdit we accept file_path or notebook_path; neither has been captured yet.
import { classifyPath } from "../../shell/paths.js";
import type { Finding, Rule, RuleContext } from "../types.js";

const ID = "file-tools/outside-project";
export const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function toolPath(ctx: RuleContext): string | null {
  const p = ctx.toolInput.file_path ?? ctx.toolInput.notebook_path;
  return typeof p === "string" && p !== "" ? p : null;
}

export const outsideProject: Rule = {
  id: ID,
  category: "file-tools",
  check(ctx) {
    if (!ctx.toolName || !WRITE_TOOLS.has(ctx.toolName)) return [];
    const path = toolPath(ctx);
    if (!path) return [];
    const cls = classifyPath(path, ctx.cwd, ctx.projectRoot, ctx.home);
    const f = (severity: Finding["severity"], where: string): Finding[] => [
      { ruleId: ID, category: "file-tools", severity, reason: `${ctx.toolName} to ${where}: ${path}.` },
    ];
    switch (cls) {
      case "inside-project":
        return [];
      case "home":
        return f("high", "your home directory, outside the project");
      case "system":
        return f("high", "a system location");
      case "outside-project":
        return f("medium", "a file outside the project");
      default:
        return f("medium", "a path that couldn't be resolved");
    }
  },
};
