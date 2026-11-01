import { describe, expect, it } from "vitest";
import { defaultConfig, type VetoConfig } from "../../src/config.js";
import { decide, formatReason } from "../../src/decide.js";
import type { Verdict } from "../../src/rules/engine.js";
import type { Finding } from "../../src/rules/types.js";

const f = (severity: Finding["severity"], ruleId = "destructive/x", suggestion?: string): Finding => ({
  ruleId,
  category: "destructive",
  severity,
  reason: `${severity} thing happened to ~/target.`,
  ...(suggestion ? { suggestion } : {}),
});
const flag = (...findings: Finding[]): Verdict => ({ verdict: "flag", findings, analysis_ms: 1 });
const guard = (over: Partial<VetoConfig> = {}): VetoConfig => ({ ...defaultConfig(), mode: "guard", ...over });

describe("decide", () => {
  it("watch mode never decides, whatever the findings", () => {
    expect(decide(flag(f("high")), defaultConfig())).toEqual({ decision: "allowed", because: [], stdout: "" });
  });

  it("guard defaults: high -> deny, medium -> ask, low -> log (no output)", () => {
    expect(decide(flag(f("high")), guard()).decision).toBe("denied");
    expect(decide(flag(f("medium")), guard()).decision).toBe("asked");
    expect(decide(flag(f("low")), guard())).toEqual({ decision: "allowed", because: [], stdout: "" });
  });

  it("the strongest action across findings wins, and only those findings are cited", () => {
    const r = decide(flag(f("low", "a/low"), f("medium", "a/med"), f("high", "a/high")), guard());
    expect(r.decision).toBe("denied");
    expect(r.because.map((x) => x.ruleId)).toEqual(["a/high"]);
  });

  it("per-severity actions come from config", () => {
    const cfg = guard({ actions: { high: "ask", medium: "log", low: "deny" } });
    expect(decide(flag(f("high")), cfg).decision).toBe("asked");
    expect(decide(flag(f("medium")), cfg).decision).toBe("allowed");
    expect(decide(flag(f("low")), cfg).decision).toBe("denied");
  });

  it("allow and error verdicts never produce output", () => {
    expect(decide({ verdict: "allow", findings: [], analysis_ms: 1 }, guard()).stdout).toBe("");
    expect(decide({ verdict: "error", findings: [], analysis_ms: 1, error: "boom" }, guard()).stdout).toBe("");
  });

  it("deny output is the documented JSON shape; never 'allow'", () => {
    const r = decide(flag(f("high", "destructive/force-push", "Push to a branch and open a PR.")), guard());
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Veto: blocked this call. [destructive/force-push] high thing happened to ~/target. Safer: Push to a branch and open a PR.",
      },
    });
    expect(r.stdout.endsWith("\n")).toBe(true);
    expect(r.stdout).not.toContain('"allow"');
  });

  it("ask output also tells Claude why, via additionalContext", () => {
    const out = JSON.parse(decide(flag(f("medium")), guard()).stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe("ask");
    expect(out.permissionDecisionReason).toMatch(/^Veto: asking the user to confirm this call\. \[destructive\/x\]/);
    expect(out.additionalContext).toBe(out.permissionDecisionReason);
  });
});

describe("formatReason", () => {
  it("starts with Veto:, names every rule and target, de-duplicates suggestions", () => {
    const r = formatReason("ask", [f("medium", "d/a", "Confirm first."), f("medium", "d/a", "Confirm first."), f("medium", "d/b", "Copy instead.")]);
    expect(r).toBe(
      "Veto: asking the user to confirm this call. [d/a] medium thing happened to ~/target. [d/a] medium thing happened to ~/target. [d/b] medium thing happened to ~/target. Safer: Confirm first. Copy instead.",
    );
  });

  it("lists at most 5 findings and stays under 2000 chars", () => {
    const many = Array.from({ length: 9 }, (_, i) => f("high", `d/${i}`));
    expect(formatReason("deny", many)).toContain("(+4 more)");
    const long = [{ ...f("high"), reason: "x".repeat(5000) }];
    expect(formatReason("deny", long).length).toBe(2000);
  });
});
