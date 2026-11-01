import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configPath, defaultConfig, loadConfig, saveConfig, validateConfig } from "../../src/config.js";
import { tempProject } from "../helpers.js";

describe("validateConfig", () => {
  it("empty object = defaults (watch; high deny, medium ask, low log)", () => {
    expect(validateConfig({})).toEqual({ config: { mode: "watch", actions: { high: "deny", medium: "ask", low: "log" }, disabledRules: [] } });
  });

  it("partial actions merge over defaults; disabledRules are de-duplicated", () => {
    const v = validateConfig({ mode: "guard", actions: { medium: "deny" }, disabledRules: ["destructive/broad", "destructive/broad"] });
    expect(v).toEqual({ config: { mode: "guard", actions: { high: "deny", medium: "deny", low: "log" }, disabledRules: ["destructive/broad"] } });
  });

  it.each([
    [[], /JSON object/],
    ["guard", /JSON object/],
    [{ mode: "block" }, /mode must be/],
    [{ mdoe: "guard" }, /unknown key\(s\): mdoe/],
    [{ actions: [] }, /actions must be an object/],
    [{ actions: { critical: "deny" } }, /unknown severity "critical"/],
    [{ actions: { high: "allow" } }, /actions.high must be "deny", "ask" or "log", got "allow"/],
    [{ disabledRules: "destructive/broad" }, /disabledRules must be a list/],
    [{ disabledRules: [1] }, /disabledRules must be a list/],
    [{ disabledRules: [""] }, /disabledRules must be a list/],
  ])("rejects %j", (raw, msg) => {
    const v = validateConfig(raw);
    expect("error" in v && v.error).toMatch(msg);
  });

  it("'allow' is never a valid action (it would skip the user's prompt)", () => {
    expect("error" in validateConfig({ actions: { low: "allow" } })).toBe(true);
  });
});

describe("loadConfig / saveConfig", () => {
  const withVeto = () => {
    const root = tempProject();
    mkdirSync(join(root, ".veto"));
    return root;
  };

  it("no file: defaults, source default", () => {
    expect(loadConfig(tempProject())).toEqual({ config: defaultConfig(), source: "default" });
  });

  it("round-trips through the file", () => {
    const root = withVeto();
    const c = { ...defaultConfig(), mode: "guard" as const, disabledRules: ["file-tools/secret-path"] };
    saveConfig(root, c);
    expect(loadConfig(root)).toEqual({ config: c, source: "file" });
  });

  it("invalid JSON or invalid values: watch mode with an error naming the file", () => {
    const root = withVeto();
    writeFileSync(configPath(root), "{ mode: guard");
    const a = loadConfig(root);
    expect(a.source).toBe("invalid");
    expect(a.config.mode).toBe("watch");
    expect(a.error).toContain(configPath(root));
    writeFileSync(configPath(root), JSON.stringify({ mode: "guard", actions: { high: "nope" } }));
    const b = loadConfig(root);
    expect(b).toMatchObject({ source: "invalid", config: { mode: "watch" } });
    expect(b.error).toMatch(/actions.high/);
  });
});
