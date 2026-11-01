import { describe, expect, it } from "vitest";
import { mayMention } from "../../src/rules/engine.js";
import { selfOverride } from "../../src/rules/self-protection/override.js";
import { ROOT, runBash, sev, toolCtx } from "../rule-helpers.js";

const s = (command: string) => sev(runBash(selfOverride, command));

describe("self-protection/override", () => {
  it("the agent running veto allow / mode watch / uninstall: high, tells the user to run it themselves", () => {
    expect(runBash(selfOverride, "veto allow --once")).toEqual([
      {
        ruleId: "self-protection/override",
        category: "self-protection",
        severity: "high",
        reason: "veto allow run by the agent would override Veto; the user must run it in their own terminal.",
        suggestion: "Tell the user what you want to do and why; if they agree, they can run `veto allow --once` in their own terminal and ask you to retry.",
      },
    ]);
    for (const c of [
      "veto allow destructive/git-discard",
      "cd /tmp && veto allow --once",
      "git status && veto allow --once && git reset --hard",
      "sudo veto allow --once",
      "/usr/local/bin/veto allow --once",
      "npx getveto allow --once",
      "npx -y getveto@0.1.0 allow --once",
      "node /home/alice/.nvm/versions/node/v22/lib/node_modules/getveto/dist/cli.js allow --once",
      "node /home/alice/code/GetVeto/dist/cli.js allow --once",
      "veto mode watch",
      "veto mode $M",
      "veto uninstall",
      "bash -c 'veto allow --once'",
      `bash -c "$X; veto allow --once"`,
    ]) {
      expect(s(c), c).toBe("high");
    }
  });

  it("read-only and tightening veto commands are fine", () => {
    for (const c of ["veto log", "veto log --flagged", "veto status", "veto mode", "veto mode guard", "veto deny destructive/broad", "veto init --guard", "echo veto allow", "cat .veto/log.jsonl", "ls -la .veto"]) {
      expect(s(c), c).toBeNull();
    }
  });

  it("shell redirects into the project's .veto/: high", () => {
    for (const c of ["echo '{}' > .veto/config.json", `echo x >> ${ROOT}/.veto/override.json`, "cd .veto && echo x > config.json", "printf x > .veto"]) {
      expect(s(c), c).toBe("high");
    }
    expect(s("echo x > notes/.veto-ideas.md")).toBeNull();
    expect(s("echo x > /tmp/.veto/config.json")).toBeNull(); // another folder's .veto
  });

  it("Write / Edit on .veto/ files: high; elsewhere: not this rule", () => {
    const tool = (name: string, file_path: string) => sev(selfOverride.check(toolCtx(name, { file_path })));
    expect(tool("Write", `${ROOT}/.veto/config.json`)).toBe("high");
    expect(tool("Edit", ".veto/config.json")).toBe("high");
    expect(tool("Edit", `${ROOT}/src/veto.ts`)).toBeNull();
    expect(tool("Read", `${ROOT}/.veto/log.jsonl`)).toBeNull();
  });

  it("its trigger words cover the cases (so the engine still skips the parser otherwise)", () => {
    for (const c of ["veto allow --once", "npx getveto allow", "node /x/GetVeto/dist/cli.js allow", "echo > .veto/config.json"]) {
      expect(mayMention(c, selfOverride.triggers!), c).toBe(true);
    }
    expect(mayMention("npm test && git status", selfOverride.triggers!)).toBe(false);
  });
});
