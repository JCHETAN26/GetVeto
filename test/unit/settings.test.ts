import { describe, expect, it } from "vitest";
import {
  addVetoHooks,
  containsVeto,
  gitignoreAppend,
  gitignoreHas,
  isVetoHandler,
  parseSettings,
  removeVetoHooks,
  SettingsShapeError,
  VETO_EVENTS,
  vetoHandler,
} from "../../src/settings.js";

const otherHook = {
  matcher: "Bash",
  hooks: [{ type: "command", command: "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh" }],
};

describe("addVetoHooks", () => {
  it("no settings: adds a '*' group for every Veto event", () => {
    const { settings, added } = addVetoHooks({});
    expect(added).toEqual([...VETO_EVENTS]);
    for (const ev of VETO_EVENTS) {
      expect((settings.hooks as any)[ev]).toEqual([{ matcher: "*", hooks: [vetoHandler()] }]);
    }
  });

  it("existing settings with other hooks and keys: keeps them, appends Veto", () => {
    const input = {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: { PreToolUse: [otherHook], Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    const { settings, added } = addVetoHooks(input);
    expect(input).toEqual(snapshot); // input not mutated
    expect(added).toEqual([...VETO_EVENTS]);
    expect(settings.permissions).toEqual(input.permissions);
    const hooks = settings.hooks as any;
    expect(hooks.Stop).toEqual(input.hooks.Stop);
    expect(hooks.PreToolUse[0]).toEqual(otherHook);
    expect(hooks.PreToolUse[1]).toEqual({ matcher: "*", hooks: [vetoHandler()] });
  });

  it("existing Veto hook: idempotent, nothing added", () => {
    const once = addVetoHooks({}).settings;
    const twice = addVetoHooks(once);
    expect(twice.added).toEqual([]);
    expect(twice.settings).toEqual(once);
  });

  it("partial install (only PreToolUse has Veto): adds the missing events only", () => {
    const input = { hooks: { PreToolUse: [{ matcher: "*", hooks: [vetoHandler()] }] } };
    const { added } = addVetoHooks(input);
    expect(added).toEqual(["PostToolUse", "PostToolUseFailure"]);
  });

  it("rejects malformed shapes instead of clobbering them", () => {
    expect(() => addVetoHooks({ hooks: [] as unknown as object })).toThrow(SettingsShapeError);
    expect(() => addVetoHooks({ hooks: { PreToolUse: {} } })).toThrow(SettingsShapeError);
  });
});

describe("removeVetoHooks", () => {
  it("no hooks: unchanged", () => {
    const r = removeVetoHooks({ model: "x" });
    expect(r.changed).toBe(false);
    expect(r.settings).toEqual({ model: "x" });
  });

  it("round-trip restores the original settings exactly", () => {
    const original = { permissions: { deny: ["Read(./.env)"] }, hooks: { PreToolUse: [otherHook] } };
    const installed = addVetoHooks(original).settings;
    const r = removeVetoHooks(installed);
    expect(r.changed).toBe(true);
    expect(r.removed).toEqual({ PreToolUse: 1, PostToolUse: 1, PostToolUseFailure: 1 });
    expect(r.settings).toEqual(original);
  });

  it("only Veto hooks: removes the hooks key entirely", () => {
    const r = removeVetoHooks(addVetoHooks({ model: "m" }).settings);
    expect(r.settings).toEqual({ model: "m" });
  });

  it("keeps non-Veto handlers that share a group with Veto", () => {
    const shared = { matcher: "*", hooks: [vetoHandler(), { type: "command", command: "echo hi" }] };
    const r = removeVetoHooks({ hooks: { PreToolUse: [shared] } });
    expect(r.settings).toEqual({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo hi" }] }] } });
  });

  it("removes Veto from any event, including ones Veto doesn't install by default", () => {
    const r = removeVetoHooks({ hooks: { Stop: [{ hooks: [vetoHandler()] }] } });
    expect(r.removed).toEqual({ Stop: 1 });
    expect(r.settings).toEqual({});
  });
});

describe("isVetoHandler / containsVeto", () => {
  it("recognizes exec form and hand-written shell form, nothing else", () => {
    expect(isVetoHandler(vetoHandler())).toBe(true);
    expect(isVetoHandler({ type: "command", command: "veto hook" })).toBe(true);
    expect(isVetoHandler({ type: "command", command: "veto", args: ["log"] })).toBe(false);
    expect(isVetoHandler({ type: "command", command: "not-veto hook" })).toBe(false);
    expect(isVetoHandler({ type: "http", command: "veto", args: ["hook"] })).toBe(false);
    expect(containsVeto({ hooks: { PreToolUse: [otherHook] } })).toBe(false);
  });
});

describe("parseSettings", () => {
  it("treats an empty file as {}", () => expect(parseSettings("  \n")).toEqual({}));
  it("throws on invalid JSON and non-objects", () => {
    expect(() => parseSettings("{,}")).toThrow();
    expect(() => parseSettings("[]")).toThrow(SettingsShapeError);
  });
});

describe("gitignore helpers", () => {
  it("matches common spellings", () => {
    for (const t of [".veto/\n", ".veto\n", "/.veto/\n", "# c\n  .veto/  \n"]) expect(gitignoreHas(t, ".veto/")).toBe(true);
    expect(gitignoreHas("# .veto/\n", ".veto/")).toBe(false);
    expect(gitignoreHas(".vetoes/\n", ".veto/")).toBe(false);
  });
  it("appends with a separating newline", () => {
    expect(gitignoreAppend("node_modules", [".veto/"])).toBe("node_modules\n.veto/\n");
    expect(gitignoreAppend("", [".veto/"])).toBe(".veto/\n");
  });
});

describe("absolute handler + in-place upgrade", () => {
  const spec = { node: "/usr/bin/node", cli: "/opt/getveto/dist/cli.js" };
  const abs = vetoHandler(spec);

  it("absolute handler shape", () => {
    expect(abs).toEqual({ type: "command", command: "/usr/bin/node", args: ["/opt/getveto/dist/cli.js", "hook"], timeout: 10 });
    expect(isVetoHandler(abs)).toBe(true);
  });

  it("does not claim someone else's `node something/cli.js hook`", () => {
    expect(isVetoHandler({ type: "command", command: "node", args: ["/x/other-tool/dist/cli.js", "hook"] })).toBe(false);
    expect(isVetoHandler({ type: "command", command: "node", args: ["/x/getveto/dist/cli.js", "log"] })).toBe(false);
    // ...unless the caller's predicate says that path is a Veto CLI
    expect(isVetoHandler({ type: "command", command: "node", args: ["/x/clone/dist/cli.js", "hook"] }, () => true)).toBe(true);
  });

  it("upgrades the old relative entry in place and is idempotent afterwards", () => {
    const old = addVetoHooks({}).settings; // Task #1 portable form
    const up = addVetoHooks(old, abs);
    expect(up.added).toEqual([]);
    expect(up.upgraded).toEqual([...VETO_EVENTS]);
    for (const ev of VETO_EVENTS) expect((up.settings.hooks as any)[ev]).toEqual([{ matcher: "*", hooks: [abs] }]);
    const again = addVetoHooks(up.settings, abs);
    expect(again.added).toEqual([]);
    expect(again.upgraded).toEqual([]);
    expect(again.settings).toEqual(up.settings);
  });

  it("collapses duplicate Veto entries but leaves other handlers and user-empty groups alone", () => {
    const userEmpty = { matcher: "Read", hooks: [] };
    const input = {
      hooks: {
        PreToolUse: [
          userEmpty,
          { matcher: "*", hooks: [vetoHandler(), { type: "command", command: "echo keep" }] },
          { matcher: "*", hooks: [vetoHandler()] },
        ],
      },
    };
    const { settings, upgraded } = addVetoHooks(input, abs);
    expect(upgraded).toContain("PreToolUse");
    expect((settings.hooks as any).PreToolUse).toEqual([
      userEmpty,
      { matcher: "*", hooks: [abs, { type: "command", command: "echo keep" }] },
    ]);
  });

  it("switching back to portable (--shared) also upgrades in place", () => {
    const withAbs = addVetoHooks({}, abs).settings;
    const r = addVetoHooks(withAbs, vetoHandler());
    expect(r.upgraded).toEqual([...VETO_EVENTS]);
    expect(removeVetoHooks(r.settings).settings).toEqual({});
  });
});
