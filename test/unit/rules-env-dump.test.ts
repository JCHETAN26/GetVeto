import { describe, expect, it } from "vitest";
import { envDump } from "../../src/rules/secret-access/env-dump.js";
import { runBash, sev } from "../rule-helpers.js";

const s = (command: string) => sev(runBash(envDump, command));

describe("secret-access/env-dump", () => {
  it("full dumps are low, with a safer alternative", () => {
    expect(runBash(envDump, "printenv")).toEqual([
      {
        ruleId: "secret-access/env-dump",
        category: "secret-access",
        severity: "low",
        reason: "printenv prints every environment variable, which can include API keys and tokens.",
        suggestion: "Print only the variable you need (e.g. `printenv NODE_ENV`), or ask the user for the specific value you need.",
      },
    ]);
    for (const c of ["env", "env | sort", "set", "export -p"]) expect(s(c), c).toBe("low");
  });

  it("one variable, a wrapped command, or shell options: not flagged", () => {
    for (const c of ["printenv PATH", "env NODE_ENV=test npm test", "set -euo pipefail", "export PATH=$PATH:./bin", "echo $HOME"]) expect(s(c), c).toBeNull();
  });
});
