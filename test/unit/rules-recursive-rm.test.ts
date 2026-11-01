import { describe, expect, it } from "vitest";
import { recursiveRm } from "../../src/rules/destructive/recursive-rm.js";
import { runBash, sev } from "../rule-helpers.js";

const s = (command: string, cwd?: string | null) => sev(runBash(recursiveRm, command, { cwd }));

describe("destructive/recursive-rm", () => {
  it("near-miss trio: rm -rf dist (allowed) vs rm -rf src (medium) vs rm -rf ~ (high)", () => {
    expect(s("rm -rf dist")).toBeNull();
    expect(s("rm -rf src")).toBe("medium");
    expect(s("rm -rf ~")).toBe("high");
  });

  it("allows every regenerable folder, also nested and with ./ or a glob inside", () => {
    for (const c of [
      "rm -rf dist build out node_modules .cache coverage tmp .next .turbo",
      "rm -rf ./dist && npm run build",
      "rm -rf packages/web/node_modules",
      "rm -rf dist/*",
      "rm -r coverage/lcov-report",
    ]) {
      expect(s(c), c).toBeNull();
    }
  });

  it("other project folders are medium; the project root itself is high", () => {
    expect(s("rm -rf .git")).toBe("medium");
    expect(s("rm -R test")).toBe("medium");
    expect(s("rm --recursive docs")).toBe("medium");
    expect(s("rm -rf .")).toBe("high");
    expect(s('rm -rf "$PWD"')).toBe("high");
    expect(s("rm -rf ../app")).toBe("high");
  });

  it("home, system and outside-project targets", () => {
    expect(s("rm -rf ~/Downloads")).toBe("high");
    expect(s("rm -rf $HOME/Downloads")).toBe("high");
    expect(s("sudo rm -rf /usr/local/lib/old")).toBe("high");
    expect(s("rm -rf /")).toBe("high");
    expect(s("rm -rf /tmp/build-cache")).toBe("medium");
  });

  it("follows cd: the same word means a different place", () => {
    expect(s("cd src && rm -rf dist")).toBeNull(); // src/dist is regenerable
    expect(s("cd .. && rm -rf app-old")).toBe("high"); // /home/alice/code/app-old is in home
  });

  it("only recursive deletes count", () => {
    expect(s("rm -f package-lock.json")).toBeNull();
    expect(s("rm notes.txt")).toBeNull();
    expect(s("echo rm -rf ~")).toBeNull();
    expect(s("git rm -r --cached dist")).toBeNull();
  });

  it("unresolved targets are flagged one level lower, saying so", () => {
    const f = runBash(recursiveRm, "rm -rf $BUILD_DIR");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("medium");
    expect(f[0]!.reason).toMatch(/couldn't be resolved/);
    expect(s("rm -rf ~/Downloads/*")).toBe("medium"); // high, lowered: glob
    expect(s("rm -rf src/*")).toBe("low"); // medium, lowered
    expect(s("rm -rf src", null)).toBe("medium"); // unknown cwd
    expect(s("cd $DIR && rm -rf docs")).toBe("medium");
    expect(s("find . -name '*.tmp' | xargs rm -rf")).toBe("medium");
  });

  it("looks inside bash -c, and flags unparsed nested scripts that mention rm -r", () => {
    expect(s("bash -c 'rm -rf dist && npm run build'")).toBeNull();
    expect(s("bash -c 'cd .. && rm -rf app'")).toBe("high");
    const deep = `bash -c "sh -c 'dash -c \\"zsh -c \\\\\\"rm -rf src\\\\\\"\\"'"`;
    const f = runBash(recursiveRm, deep);
    expect(sev(f)).toBe("medium");
    expect(f.some((x) => /nested script/.test(x.reason))).toBe(true);
    expect(s('bash -c "$SCRIPT"')).toBeNull(); // nothing to go on: see gaps
  });

  it("reasons are one short sentence", () => {
    for (const f of runBash(recursiveRm, "rm -rf ~/Downloads src $X")) {
      expect(f.reason).toMatch(/^[A-Z].*\.$/);
      expect(f.reason.length).toBeLessThan(140);
    }
  });
});
