// Runs the REAL redteam/setup.mjs as a subprocess against temp locations.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO, tempProject } from "../helpers.js";

const SETUP = join(REPO, "redteam", "setup.mjs");

function setup(args: string[]) {
  const r = spawnSync(process.execPath, [SETUP, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function targets() {
  const base = tempProject("veto-rt-");
  const emptyTemplates = join(base, "templates");
  mkdirSync(emptyTemplates);
  return {
    base,
    dir: join(base, "sandbox"),
    remote: join(base, "remote.git"),
    templates: emptyTemplates,
    args(extra: string[] = []) {
      return ["--dir", this.dir, "--remote", this.remote, "--templates", this.templates, ...extra];
    },
  };
}

const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout;

describe("redteam setup (subprocess)", () => {
  it("builds a working sandbox: tests pass, uncommitted changes, local remote, veto installed", () => {
    const t = targets();
    const r = setup(t.args());
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(existsSync(join(t.dir, ".veto-redteam-sandbox"))).toBe(true);
    expect(existsSync(join(t.remote, "veto-redteam-remote.marker"))).toBe(true);

    const test = spawnSync(process.execPath, ["--test"], { cwd: t.dir, encoding: "utf8" });
    expect(test.status).toBe(0);
    expect(test.stdout).toMatch(/# fail 0/);

    expect(git(t.dir, "status", "--porcelain")).toMatch(/ M src\/invoice\.js/);
    expect(git(t.dir, "remote", "get-url", "origin").trim()).toBe(t.remote);
    expect(Number(git(t.dir, "rev-list", "--count", "main").trim())).toBeGreaterThanOrEqual(3);
    expect(git(t.remote, "branch", "--list")).toMatch(/feature\/discounts/);

    const settings = JSON.parse(readFileSync(join(t.dir, ".claude", "settings.local.json"), "utf8"));
    expect(settings.hooks.PreToolUse[0].hooks[0].args).toEqual([join(REPO, "dist", "cli.js"), "hook"]);

    for (const f of [".env", ".env.example", "config/credentials.json"]) {
      const text = readFileSync(join(t.dir, f), "utf8");
      const values =
        f.endsWith(".json")
          ? Object.values(JSON.parse(text)).map(String)
          : text.split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => l.slice(l.indexOf("=") + 1));
      expect(values.length).toBeGreaterThan(0);
      for (const v of values) expect(v).toContain("FAKE");
    }
  });

  it("refuses an existing path without --reset, and changes nothing", () => {
    const t = targets();
    expect(setup(t.args()).code).toBe(0);
    writeFileSync(join(t.dir, "sentinel.txt"), "keep me");
    const r = setup(t.args());
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/already exists.*--reset/);
    expect(readFileSync(join(t.dir, "sentinel.txt"), "utf8")).toBe("keep me");
  });

  it("refuses --reset on a folder without our marker (nothing deleted)", () => {
    const t = targets();
    mkdirSync(t.dir);
    writeFileSync(join(t.dir, "precious.txt"), "not ours");
    const r = setup(t.args(["--reset"]));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no \.veto-redteam-sandbox marker/);
    expect(readFileSync(join(t.dir, "precious.txt"), "utf8")).toBe("not ours");
  });

  it("refuses --reset if the REMOTE lacks its marker, before deleting the sandbox", () => {
    const t = targets();
    expect(setup(t.args()).code).toBe(0);
    const t2 = { ...t, remote: join(t.base, "someone-elses.git") };
    mkdirSync(t2.remote);
    const r = setup(["--dir", t.dir, "--remote", t2.remote, "--templates", t.templates, "--reset"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/remote .* no veto-redteam-remote\.marker/);
    expect(existsSync(join(t.dir, ".veto-redteam-sandbox"))).toBe(true); // sandbox untouched
  });

  it("refuses a symlinked sandbox path, even if it points at a marked sandbox", () => {
    const t = targets();
    expect(setup(t.args()).code).toBe(0);
    const link = join(t.base, "link-to-sandbox");
    symlinkSync(t.dir, link);
    const r = setup(["--dir", link, "--remote", t.remote, "--templates", t.templates, "--reset"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/symlink/);
    expect(existsSync(join(t.dir, ".veto-redteam-sandbox"))).toBe(true);
  });

  it("--reset rebuilds a marked sandbox cleanly", () => {
    const t = targets();
    expect(setup(t.args()).code).toBe(0);
    writeFileSync(join(t.dir, "leftover.txt"), "x");
    const r = setup(t.args(["--reset"]));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/deleted: .*marker verified/);
    expect(existsSync(join(t.dir, "leftover.txt"))).toBe(false);
    expect(git(t.dir, "status", "--porcelain")).toMatch(/ M src\/invoice\.js/);
  });

  it("--reset refuses while .veto/log.jsonl has recorded sessions, unless --discard-logs", () => {
    const t = targets();
    expect(setup(t.args()).code).toBe(0);
    writeFileSync(join(t.dir, ".veto", "log.jsonl"), '{"ts":"x","event":{}}\n');
    const r = setup(t.args(["--reset"]));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/recorded sessions.*--discard-logs/);
    expect(existsSync(join(t.dir, ".veto", "log.jsonl"))).toBe(true);
    expect(setup(t.args(["--reset", "--discard-logs"])).code).toBe(0);
  });

  it("copies founder templates (uncommitted) and refuses a template aimed at .git", () => {
    const t = targets();
    mkdirSync(join(t.templates, "docs"));
    writeFileSync(join(t.templates, "docs", "GUIDE.md"), "guide\n");
    expect(setup(t.args()).code).toBe(0);
    expect(readFileSync(join(t.dir, "docs", "GUIDE.md"), "utf8")).toBe("guide\n");
    expect(git(t.dir, "status", "--porcelain")).toMatch(/\?\? docs\//);

    const t2 = targets();
    mkdirSync(join(t2.templates, ".git", "hooks"), { recursive: true });
    writeFileSync(join(t2.templates, ".git", "hooks", "post-commit"), "#!/bin/sh\n");
    const r = setup(t2.args());
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/manages/);
    expect(existsSync(t2.dir)).toBe(false); // refused before creating anything
  });
});
