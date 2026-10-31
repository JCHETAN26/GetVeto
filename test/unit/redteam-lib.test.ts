import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error: plain ESM module without type declarations
import * as lib from "../../redteam/lib.mjs";
import { tempProject } from "../helpers.js";

const { isInside, listTemplateFiles, MARKER_TOKEN, planTarget, SANDBOX_MARKER, SetupError, validateTarget } = lib;
const opts = { marker: SANDBOX_MARKER, label: "sandbox" };

describe("validateTarget", () => {
  const ctx = { home: "/home/u", repo: "/home/u/projects/GetVeto", label: "sandbox" };
  it("accepts an ordinary absolute path", () => {
    expect(validateTarget("/home/u/veto-redteam", ctx)).toBe("/home/u/veto-redteam");
  });
  it.each([
    ["relative path", "veto-redteam"],
    ["filesystem root", "/"],
    ["home itself", "/home/u"],
    ["home with trailing slash", "/home/u/"],
    ["the repo", "/home/u/projects/GetVeto"],
    ["a parent of the repo", "/home/u/projects"],
  ])("refuses %s", (_l, p) => {
    expect(() => validateTarget(p, ctx)).toThrow(SetupError);
  });
});

describe("planTarget", () => {
  it("absent path -> create", () => {
    expect(planTarget(join(tempProject(), "nope"), { ...opts, reset: false })).toBe("create");
  });
  it("existing path without --reset -> refuses", () => {
    const d = tempProject();
    writeFileSync(join(d, SANDBOX_MARKER), MARKER_TOKEN);
    expect(() => planTarget(d, { ...opts, reset: false })).toThrow(/already exists/);
  });
  it("--reset but no marker -> refuses", () => {
    expect(() => planTarget(tempProject(), { ...opts, reset: true })).toThrow(/no .* marker/);
  });
  it("--reset with a marker that lacks our token -> refuses", () => {
    const d = tempProject();
    writeFileSync(join(d, SANDBOX_MARKER), "something else");
    expect(() => planTarget(d, { ...opts, reset: true })).toThrow(/token/);
  });
  it("--reset with our marker -> reset", () => {
    const d = tempProject();
    writeFileSync(join(d, SANDBOX_MARKER), MARKER_TOKEN + "\n");
    expect(planTarget(d, { ...opts, reset: true })).toBe("reset");
  });
  it("symlink to a marked dir -> refuses (even with --reset)", () => {
    const real = tempProject();
    writeFileSync(join(real, SANDBOX_MARKER), MARKER_TOKEN);
    const link = join(tempProject(), "link");
    symlinkSync(real, link);
    expect(() => planTarget(link, { ...opts, reset: true })).toThrow(/symlink/);
  });
  it("path through a symlinked parent -> refuses", () => {
    const realParent = tempProject();
    mkdirSync(join(realParent, "box"));
    writeFileSync(join(realParent, "box", SANDBOX_MARKER), MARKER_TOKEN);
    const linkParent = join(tempProject(), "lp");
    symlinkSync(realParent, linkParent);
    expect(() => planTarget(join(linkParent, "box"), { ...opts, reset: true })).toThrow(/resolves to/);
  });
  it("a regular file at the path -> refuses", () => {
    const f = join(tempProject(), "f");
    writeFileSync(f, "x");
    expect(() => planTarget(f, { ...opts, reset: true })).toThrow(/not a directory/);
  });
  it("dangling symlink -> refuses", () => {
    const link = join(tempProject(), "dangling");
    symlinkSync("/nonexistent/veto-target", link);
    expect(() => planTarget(link, { ...opts, reset: true })).toThrow(/symlink/);
  });
});

describe("listTemplateFiles", () => {
  const make = (files: Record<string, string>) => {
    const t = tempProject();
    for (const [rel, c] of Object.entries(files)) {
      mkdirSync(join(t, rel, ".."), { recursive: true });
      writeFileSync(join(t, rel), c);
    }
    return t;
  };
  it("lists nested files, skips the folder README, maps README.sandbox.md -> README.md", () => {
    const t = make({ "README.md": "docs", "README.sandbox.md": "r", "docs/A.md": "a", "issues/B.md": "b" });
    const out = listTemplateFiles(t, "/sandbox").map((f: { rel: string }) => f.rel);
    expect(out).toEqual(["README.md", "docs/A.md", "issues/B.md"]);
  });
  it("missing templates folder -> empty", () => {
    expect(listTemplateFiles(join(tempProject(), "none"), "/sandbox")).toEqual([]);
  });
  it.each([".git/hooks/post-commit", ".claude/settings.local.json", ".veto/log.jsonl", SANDBOX_MARKER])(
    "refuses a template targeting %s",
    (rel) => {
      const t = make({ [rel]: "x" });
      expect(() => listTemplateFiles(t, "/sandbox")).toThrow(/manages/);
    },
  );
  it("refuses symlinks (file or dir)", () => {
    const t = make({ "ok.md": "x" });
    symlinkSync("/etc/hostname", join(t, "evil.md"));
    expect(() => listTemplateFiles(t, "/sandbox")).toThrow(/symlink/);
    const t2 = make({});
    symlinkSync("/etc", join(t2, "etcdir"));
    expect(() => listTemplateFiles(t2, "/sandbox")).toThrow(/symlink/);
  });
});

describe("isInside", () => {
  it("handles prefixes correctly", () => {
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
  });
});
