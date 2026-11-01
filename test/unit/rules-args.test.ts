import { describe, expect, it } from "vitest";
import { display, hasLong, hasShort, resolveTarget, splitArgs } from "../../src/rules/args.js";
import { bashCtx, HOME, ROOT } from "../rule-helpers.js";

const first = (command: string, cwd: string | null = ROOT) => {
  const ctx = bashCtx(command, { cwd });
  return { ctx, cmd: ctx.commands[0]! };
};

describe("splitArgs / hasShort / hasLong", () => {
  it("separates options from operands and honours --", () => {
    const { cmd } = first("rm -rf --verbose dist -- -weird-name");
    const s = splitArgs(cmd.argWords);
    expect(s.options).toEqual(["-rf", "--verbose"]);
    expect(s.operands.map((a) => a.value)).toEqual(["dist", "-weird-name"]);
    expect(hasShort(s.options, "r")).toBe(true);
    expect(hasShort(s.options, "v")).toBe(false); // --verbose is long
    expect(hasLong(["--force-with-lease=main"], "--force-with-lease")).toBe(true);
    expect(hasLong(["--force-with-lease"], "--force")).toBe(false);
  });

  it("an unresolved word is an operand even if it might expand to an option", () => {
    const { cmd } = first("rm -r $X");
    expect(splitArgs(cmd.argWords).operands.map((a) => a.raw)).toEqual(["$X"]);
  });
});

describe("resolveTarget", () => {
  it("exact paths classify normally", () => {
    const { ctx, cmd } = first("ls dist ~/Downloads /etc ..");
    const t = cmd.argWords.map((a) => resolveTarget(a, cmd.cwd, ctx));
    expect(t.map((x) => x.cls)).toEqual(["inside-project", "home", "system", "home"]);
    expect(t[0]).toEqual({ cls: "inside-project", abs: `${ROOT}/dist`, exact: true });
  });

  it("a glob is bounded by its fixed directory prefix", () => {
    const { ctx, cmd } = first("ls dist/* *.log ~/Downloads/* /tmp/build-*");
    const t = cmd.argWords.map((a) => resolveTarget(a, cmd.cwd, ctx));
    expect(t.map((x) => [x.cls, x.abs, x.exact])).toEqual([
      ["inside-project", `${ROOT}/dist`, false],
      ["inside-project", ROOT, false],
      ["home", `${HOME}/Downloads`, false],
      ["outside-project", "/tmp", false],
    ]);
  });

  it("variables, or .. after the glob, are unknown", () => {
    const { ctx, cmd } = first("ls $OUT dist/$NAME dist/*/../.. {src,dist}");
    const t = cmd.argWords.map((a) => resolveTarget(a, cmd.cwd, ctx));
    expect(t.map((x) => x.cls)).toEqual(["unknown", "unknown", "unknown", "inside-project"]);
    expect(t[3]!.abs).toBe(ROOT); // {src,dist} expands inside the cwd
  });

  it("relative paths with an unknown cwd are unknown", () => {
    const { ctx, cmd } = first("ls src", null);
    expect(resolveTarget(cmd.argWords[0]!, cmd.cwd, ctx)).toEqual({ cls: "unknown", abs: null, exact: true });
  });

  it("display shortens home paths", () => {
    const { ctx, cmd } = first("ls ~/Downloads ~ /etc $X");
    const shown = cmd.argWords.map((a) => display(resolveTarget(a, cmd.cwd, ctx).abs, a, ctx));
    expect(shown).toEqual(["~/Downloads", "~", "/etc", "$X"]);
  });
});
