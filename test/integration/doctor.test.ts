// `veto doctor` through the BUILT CLI (npm test builds first).
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, tempProject } from "../helpers.js";

const LOCAL = join(".claude", "settings.local.json");

describe("veto doctor", () => {
  it("a fresh project with no hook: reports the missing hook, exit 1", async () => {
    const root = tempProject();
    const r = await runCli(["doctor"], { cwd: root });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/Node \d+\.\d+\.\d+ \(>= 22\)/);
    expect(r.stdout).toContain("✗ Hook not installed in this project");
    expect(r.stdout).toContain("Run `veto init");
    expect(r.stdout).toContain("1 problem to fix.");
  });

  it("after init: all checks pass, exit 0", async () => {
    const root = tempProject();
    await runCli(["init", "--guard"], { cwd: root });
    const r = await runCli(["doctor"], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✓ Hook installed and points at an existing CLI");
    expect(r.stdout).toContain("mode guard");
    expect(r.stdout).toContain("All checks passed.");
  });

  it("a hook pointing at a missing CLI, and an invalid config: two failures", async () => {
    const root = tempProject();
    await runCli(["init"], { cwd: root });
    const s = JSON.parse(readFileSync(join(root, LOCAL), "utf8")) as { hooks: { PreToolUse: { hooks: { args: string[] }[] }[] } };
    s.hooks.PreToolUse[0]!.hooks[0]!.args[0] = "/no/such/getveto/dist/cli.js";
    writeFileSync(join(root, LOCAL), JSON.stringify(s));
    writeFileSync(join(root, ".veto", "config.json"), "{ not json");
    const r = await runCli(["doctor"], { cwd: root });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("✗ Hook points at a CLI that no longer exists");
    expect(r.stdout).toContain("✗ Config is invalid");
    expect(r.stdout).toContain("2 problems to fix");
  });

  it("warns about a world-readable log without failing", async () => {
    const root = tempProject();
    await runCli(["init", "--guard"], { cwd: root });
    writeFileSync(join(root, ".veto", "log.jsonl"), "");
    chmodSync(join(root, ".veto"), 0o755);
    chmodSync(join(root, ".veto", "log.jsonl"), 0o644);
    const r = await runCli(["doctor"], { cwd: root });
    expect(r.code).toBe(0); // a warning, not a failure
    expect(r.stdout).toContain("! Log files are readable by other users");
    expect(r.stdout).toMatch(/chmod 600 .*log\.jsonl/);
  });

  it("the portable `veto hook` form is a warning", async () => {
    const root = tempProject();
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, LOCAL), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "veto", args: ["hook"] }] }] } }));
    const r = await runCli(["doctor"], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("! Hook installed (portable `veto hook` form)");
    expect(r.stdout).toContain("runs `veto hook` from PATH");
  });
});
