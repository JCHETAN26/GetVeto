// Commands that print the whole environment: printenv / env with no arguments, set with no
// arguments, export -p (and bare export, which prints the same list). Low: often harmless,
// but the output can include API keys and tokens.
import { basename } from "node:path";
import type { SimpleCommand } from "../../shell/parse.js";
import type { Finding, Rule } from "../types.js";

const ID = "secret-access/env-dump";
const TIP = "Print only the variable you need (e.g. `printenv NODE_ENV`), or ask the user for the specific value you need.";

/** What the command prints, or null when it isn't a full dump. */
function dump(c: SimpleCommand): string | null {
  if (c.program === null || c.programUnresolved) return null;
  const prog = basename(c.program);
  const args = c.argWords;
  if ((prog === "printenv" || prog === "env") && args.length === 0) return `${prog} prints every environment variable`;
  if (prog === "set" && args.length === 0) return "set prints every shell variable";
  if (prog === "export" && (args.length === 0 || (args.length === 1 && !args[0]!.unresolved && args[0]!.value === "-p"))) {
    return `${args.length ? "export -p" : "export"} prints every exported variable`;
  }
  return null;
}

export const envDump: Rule = {
  id: ID,
  category: "secret-access",
  triggers: ["printenv", "env", "set", "export"],
  check(ctx) {
    const out: Finding[] = [];
    for (const c of ctx.commands) {
      const what = dump(c);
      if (what) out.push({ ruleId: ID, category: "secret-access", severity: "low", reason: `${what}, which can include API keys and tokens.`, suggestion: TIP });
    }
    return out;
  },
};
