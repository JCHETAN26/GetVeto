// Watch mode through the BUILT CLI (run `npm test`, which builds first).
// Payloads are the REAL captured fixtures. Their redaction placeholder /REDACTED_PROJECT is
// replaced with a temp project dir (the capture script put it there in place of the real
// path). For flagged cases, only the command / file_path value of a real payload is changed;
// the payload shape is the captured one.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFixtures, runCli, tempProject } from "../helpers.js";

const pre = loadFixtures().filter((f) => f.source === "real" && f.event.hook_event_name === "PreToolUse");
const post = loadFixtures().filter((f) => f.source === "real" && f.event.hook_event_name !== "PreToolUse");

function lines(root: string) {
  return readFileSync(join(root, ".veto", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function hook(raw: string, root: string) {
  const r = await runCli(["hook"], { cwd: root, stdin: raw, env: { CLAUDE_PROJECT_DIR: root } });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(""); // watch mode: never a decision
  return lines(root).at(-1)!;
}

const placed = (raw: string, root: string) => raw.replaceAll("/REDACTED_PROJECT", root);
function withInput(raw: string, root: string, patch: Record<string, string>): string {
  const ev = JSON.parse(placed(raw, root)) as { tool_input: Record<string, unknown> };
  Object.assign(ev.tool_input, patch);
  return JSON.stringify(ev);
}

describe("veto hook in watch mode (real fixtures)", () => {
  it("has real PreToolUse fixtures", () => expect(pre.length).toBeGreaterThan(0));

  it.each(pre.map((f) => [f.name, f] as const))("%s: benign, verdict allow, logged with analysis_ms", async (_n, f) => {
    const root = tempProject();
    const line = await hook(placed(f.raw, root), root);
    expect(line.verdict).toBe("allow");
    expect(line.findings).toEqual([]);
    expect(typeof line.analysis_ms).toBe("number");
    expect(line.event).toEqual(JSON.parse(placed(f.raw, root)));
    expect(existsSync(join(root, ".veto", "errors.log"))).toBe(false);
  });

  it("non-PreToolUse events get no verdict fields", async () => {
    const root = tempProject();
    for (const f of post) {
      const line = await hook(placed(f.raw, root), root);
      expect(line).not.toHaveProperty("verdict");
    }
  });

  it("a destructive Bash command is flagged but still allowed (exit 0, empty stdout)", async () => {
    const bash = pre.find((f) => f.event.tool_name === "Bash")!;
    const root = tempProject();
    const line = await hook(withInput(bash.raw, root, { command: "git push -f origin main" }), root);
    expect(line.verdict).toBe("flag");
    expect(line.findings).toEqual([
      { ruleId: "destructive/force-push", category: "destructive", severity: "high", reason: "Force push to main rewrites shared history." },
    ]);
  });

  it("an Edit outside the project is flagged; the same Edit inside is not", async () => {
    const edit = pre.find((f) => f.event.tool_name === "Edit")!;
    const root = tempProject();
    const outside = await hook(withInput(edit.raw, root, { file_path: "/etc/hosts" }), root);
    expect(outside.verdict).toBe("flag");
    expect((outside.findings as { ruleId: string }[])[0]!.ruleId).toBe("file-tools/outside-project");
    const inside = await hook(placed(edit.raw, root), root);
    expect(inside.verdict).toBe("allow");
  });

  it("a command that doesn't parse is logged as incomplete, still allowed", async () => {
    const bash = pre.find((f) => f.event.tool_name === "Bash")!;
    const root = tempProject();
    const line = await hook(withInput(bash.raw, root, { command: "echo $(" }), root);
    expect(line.verdict).toBe("allow");
    expect(line.incomplete).toMatch(/did not parse/);
  });
});
