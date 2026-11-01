// What ships in dist/ (scripts/bundle.mjs, docs/decisions.md D3) must work on its own: a copy of
// dist/ plus package.json with NO node_modules next to it, run as a subprocess on a REAL fixture.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFixtures, REPO, tempProject } from "../helpers.js";

describe("dist/ bundle", () => {
  it("contains only the entry, the bundle, the CommonJS marker and the licenses", () => {
    expect(readdirSync(join(REPO, "dist")).sort()).toEqual(["THIRD_PARTY_LICENSES.txt", "cli.js", "package.json", "veto.js"]);
    expect(JSON.parse(readFileSync(join(REPO, "dist", "package.json"), "utf8"))).toEqual({ type: "commonjs" });
    const bundle = readFileSync(join(REPO, "dist", "veto.js"), "utf8");
    expect(bundle).not.toMatch(/require\(["']unbash["']\)/); // bundled, not resolved at run time
    expect(readFileSync(join(REPO, "dist", "THIRD_PARTY_LICENSES.txt"), "utf8")).toContain("unbash 6.0.2");
  });

  it("a copy without node_modules runs the hook (guard ask on the real 19:53 rm), --version and init", () => {
    const install = join(tempProject("veto-install-"), "getveto");
    mkdirSync(install);
    cpSync(join(REPO, "dist"), join(install, "dist"), { recursive: true });
    cpSync(join(REPO, "package.json"), join(install, "package.json"));
    const cli = join(install, "dist", "cli.js");
    const env = { ...process.env, NODE_PATH: "" };
    delete env.CLAUDE_PROJECT_DIR;

    expect(spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8", env }).stdout.trim()).toBe(
      JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version,
    );

    const root = tempProject();
    mkdirSync(join(root, ".veto"));
    writeFileSync(join(root, ".veto", "config.json"), JSON.stringify({ mode: "guard" }));
    const raw = loadFixtures().find((f) => f.name === "17-PreToolUse-Bash.json")!.raw.replaceAll("/REDACTED_PROJECT", root);
    const r = spawnSync(process.execPath, [cli, "hook"], { input: raw, cwd: root, encoding: "utf8", env: { ...env, CLAUDE_PROJECT_DIR: root } });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");

    const proj = tempProject();
    const init = spawnSync(process.execPath, [cli, "init"], { cwd: proj, encoding: "utf8", env });
    expect(init.status).toBe(0);
    const settings = JSON.parse(readFileSync(join(proj, ".claude", "settings.local.json"), "utf8"));
    expect(settings.hooks.PreToolUse[0].hooks[0]).toMatchObject({ command: process.execPath, args: [cli, "hook"] });
  });
});

// Node's compile cache, enabled by dist/cli.js (src/entry.cjs) on Node >= 22.1.
describe("compile cache", () => {
  const hasCache = typeof (nodeModule as { enableCompileCache?: unknown }).enableCompileCache === "function";
  const rm17 = (root: string) => loadFixtures().find((f) => f.name === "17-PreToolUse-Bash.json")!.raw.replaceAll("/REDACTED_PROJECT", root);
  function hook(cacheHome: string, extra: Record<string, string> = {}) {
    const root = tempProject();
    mkdirSync(join(root, ".veto"));
    writeFileSync(join(root, ".veto", "config.json"), JSON.stringify({ mode: "guard" }));
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_CACHE_HOME: cacheHome, CLAUDE_PROJECT_DIR: root, ...extra };
    delete env.NODE_COMPILE_CACHE;
    const r = spawnSync(process.execPath, [join(REPO, "dist", "cli.js"), "hook"], { input: rm17(root), cwd: root, encoding: "utf8", env });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  }
  const files = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name)) : [];

  it.runIf(hasCache)("is written under $XDG_CACHE_HOME/getveto and nowhere else in it", () => {
    const home = tempProject("veto-xdg-");
    hook(home);
    expect(readdirSync(home)).toEqual(["getveto"]);
    expect(files(join(home, "getveto")).length).toBeGreaterThan(0);
    hook(home); // second run reads it
  });

  it("VETO_NO_COMPILE_CACHE=1 writes nothing", () => {
    const home = tempProject("veto-xdg-");
    hook(home, { VETO_NO_COMPILE_CACHE: "1" });
    expect(readdirSync(home)).toEqual([]);
  });

  it.runIf(hasCache)("a damaged cache changes nothing: same decision, no stderr", () => {
    const home = tempProject("veto-xdg-");
    hook(home);
    for (const f of files(join(home, "getveto"))) writeFileSync(f, "garbage, not a V8 code cache");
    hook(home);
    hook(home);
  });

  it("an unusable cache location changes nothing", () => {
    const base = tempProject("veto-xdg-");
    writeFileSync(join(base, "file"), "");
    hook(join(base, "file")); // XDG_CACHE_HOME is a regular file: mkdir fails
    hook("relative/path", { HOME: base }); // not absolute: ignored, falls back to $HOME/.cache
    if (hasCache) expect(files(join(base, ".cache", "getveto")).length).toBeGreaterThan(0);
  });
});
