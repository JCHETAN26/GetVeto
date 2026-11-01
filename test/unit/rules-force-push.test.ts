import { describe, expect, it } from "vitest";
import { forcePush } from "../../src/rules/destructive/force-push.js";
import { runBash, sev } from "../rule-helpers.js";

const s = (command: string) => sev(runBash(forcePush, command));

describe("destructive/force-push", () => {
  it("near-miss: push --force-with-lease feature/x (low) vs push -f main (high)", () => {
    expect(s("git push --force-with-lease origin feature/x")).toBe("low");
    expect(s("git push -f origin main")).toBe("high");
  });

  it("plain pushes are never flagged", () => {
    for (const c of ["git push", "git push origin main", "git push -u origin feature/x", "git push --tags", "git push origin HEAD"]) {
      expect(s(c), c).toBeNull();
    }
  });

  it("main/master or no branch named is high", () => {
    expect(s("git push --force")).toBe("high");
    expect(s("git push -f")).toBe("high");
    expect(s("git push --force origin")).toBe("high");
    expect(s("git push origin +master")).toBe("high");
    expect(s("git push --force origin HEAD:main")).toBe("high");
    expect(s("git push -f origin refs/heads/main")).toBe("high");
    expect(s("git push --force-with-lease origin main")).toBe("high");
    expect(s("git push --force-with-lease")).toBe("high");
    expect(s("git push --force --all origin")).toBe("high");
  });

  it("other branches: plain force medium, lease low", () => {
    expect(s("git push -f origin feature/x")).toBe("medium");
    expect(s("git push -fu origin feature/x")).toBe("medium");
    expect(s("git push origin +feature/x")).toBe("medium");
    expect(s("git push --force-with-lease=feature/x:abc123 origin feature/x")).toBe("low");
  });

  it("--mirror is high", () => {
    expect(s("git push --mirror backup")).toBe("high");
  });

  it("an unresolved branch is flagged one level lower", () => {
    const f = runBash(forcePush, "git push -f origin $BRANCH");
    expect(f[0]).toMatchObject({ severity: "medium" });
    expect(f[0]!.reason).toMatch(/couldn't be resolved/);
  });

  it("option values aren't mistaken for branches", () => {
    expect(s("git push -o ci.skip --force-with-lease origin feature/x")).toBe("low");
  });

  it("finds force pushes in chains and nested shells", () => {
    expect(s("npm test && git push -f origin main")).toBe("high");
    expect(s("bash -c 'git push --force origin main'")).toBe("high");
    expect(s(`bash -c "sh -c 'dash -c \\"zsh -c \\\\\\"git push -f\\\\\\"\\"'"`)).toBe("medium");
  });
});
