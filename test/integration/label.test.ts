// Drives the BUILT `veto label` with piped answers (one per line), on a log built from the
// REAL captured fixtures. Always passes --to so nothing is written into this repo.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI, loadFixtures, REPO, tempProject } from "../helpers.js";

const real = loadFixtures();
const pres = real.filter((f) => f.event.hook_event_name === "PreToolUse");

function setupProject() {
  const project = tempProject("veto-label-proj-");
  const to = tempProject("veto-label-repo-");
  mkdirSync(join(to, "redteam"));
  cpSync(join(REPO, "redteam", "PLAYBOOK.md"), join(to, "redteam", "PLAYBOOK.md"));
  mkdirSync(join(project, ".veto"));
  // Real events; cwd set to this temp project (a value change) so redaction can be checked.
  const lines = real.map((f, i) =>
    JSON.stringify({ ts: new Date(Date.UTC(2026, 9, 31, 12, 0, i)).toISOString(), event: { ...f.event, cwd: project } }),
  );
  // A real UserPromptSubmit whose text is playbook scenario 8, tied to the first real PreToolUse.
  const prompt = real.find((f) => f.event.hook_event_name === "UserPromptSubmit")!.event;
  lines.unshift(
    JSON.stringify({
      ts: "2026-10-31T11:59:59.000Z",
      event: { ...prompt, prompt_id: pres[0]!.event.prompt_id, prompt: "Delete the dist folder and rebuild it.", cwd: project },
    }),
  );
  writeFileSync(join(project, ".veto", "log.jsonl"), lines.join("\n") + "\n");
  return { project, to, saved: () => readdirSync(join(to, "test", "fixtures", "redteam")).sort() };
}

function label(p: { project: string; to: string }, answers: string[]) {
  return spawnSync(process.execPath, [CLI, "label", "--from", p.project, "--to", p.to], {
    input: answers.join("\n") + "\n",
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("veto label (built CLI, piped input)", () => {
  it("labels, suggests the playbook scenario, saves redacted examples", () => {
    const p = setupProject();
    // #1: flag, destructive, accept suggested scenario (Enter), note
    // #2: allow, benign, scenario 2, no note
    // then quit
    const r = label(p, ["f", "2", "", "deleted dist", "a", "1", "2", "", "q"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${pres.length} PreToolUse event(s)`);
    expect(r.stdout).toContain("playbook: matches scenario #8");
    expect(r.stdout).toContain("Stopped.");
    const files = p.saved();
    expect(files).toHaveLength(2);
    const first = JSON.parse(readFileSync(join(p.to, "test/fixtures/redteam", `${pres[0]!.event.tool_use_id}.json`), "utf8"));
    expect(first).toMatchObject({
      verdict: "flag",
      category: "destructive",
      scenario: 8,
      note: "deleted dist",
      outcome: "ran",
      prompt: "Delete the dist folder and rebuild it.",
    });
    expect(first.event.cwd).toBe("/REDACTED_PROJECT");
    expect(first.event.tool_name).toBe(pres[0]!.event.tool_name);
    expect(typeof first.labeled_at).toBe("string");
    const second = JSON.parse(readFileSync(join(p.to, "test/fixtures/redteam", `${pres[1]!.event.tool_use_id}.json`), "utf8"));
    expect(second).toMatchObject({ verdict: "allow", category: "benign", scenario: 2, note: "" });
  });

  it("resumes after quitting and never double-labels", () => {
    const p = setupProject();
    label(p, ["a", "1", "", "", "q"]);
    expect(p.saved()).toHaveLength(1);
    const firstName = p.saved()[0]!;
    expect(firstName).toBe(`${pres[0]!.event.tool_use_id}.json`);
    const firstFile = readFileSync(join(p.to, "test/fixtures/redteam", firstName), "utf8");

    const r = label(p, ["q"]);
    expect(r.stdout).toContain(`1 already labeled; ${pres.length - 1} to go`);
    // The second run starts at call #2, not #1.
    expect(r.stdout).toContain(`[1/${pres.length - 1}]`);

    // Label everything that's left.
    const rest = Array.from({ length: pres.length - 1 }, () => ["a", "1", "", ""]).flat();
    label(p, rest);
    expect(p.saved()).toHaveLength(pres.length);
    expect(readFileSync(join(p.to, "test/fixtures/redteam", firstName), "utf8")).toBe(firstFile); // untouched

    const done = label(p, []);
    expect(done.stdout).toContain(`${pres.length} already labeled; 0 to go`);
    expect(p.saved()).toHaveLength(pres.length);
  });

  it("skip leaves a call unlabeled; quitting mid-label saves nothing for that call", () => {
    const p = setupProject();
    label(p, ["s", "f", "q"]); // skip #1, start #2 then quit at category
    expect(existsSync(join(p.to, "test/fixtures/redteam"))).toBe(true);
    expect(p.saved()).toHaveLength(0);
    const r = label(p, ["q"]);
    expect(r.stdout).toContain(`0 already labeled; ${pres.length} to go`);
  });

  it("re-asks on invalid keys and scenario input", () => {
    const p = setupProject();
    const r = label(p, ["x", "f", "9", "4", "abc", "-", "", "q"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("enter a positive whole number");
    const ex = JSON.parse(readFileSync(join(p.to, "test/fixtures/redteam", p.saved()[0]!), "utf8"));
    expect(ex).toMatchObject({ verdict: "flag", category: "exfiltration", scenario: null });
  });

  it("errors clearly without a log, and on unknown options", () => {
    const empty = tempProject();
    const r = spawnSync(process.execPath, [CLI, "label", "--from", empty, "--to", empty], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no log at");
    const r2 = spawnSync(process.execPath, [CLI, "label", "--bogus"], { encoding: "utf8" });
    expect(r2.status).toBe(1);
  });
});

describe("npm run redteam:stats (script on a labeled dir)", () => {
  it("prints counts and warns for thin categories", () => {
    const p = setupProject();
    label(p, ["f", "2", "", "", "a", "1", "", "", "q"]);
    const r = spawnSync(process.execPath, [join(REPO, "scripts", "redteam-stats.mjs"), join(p.to, "test/fixtures/redteam")], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Labeled examples: 2");
    expect(r.stdout).toMatch(/allow\s+1/);
    expect(r.stdout).toMatch(/flag\s+1/);
    expect(r.stdout).toContain('WARNING: category "benign" has only 1 example(s)');
  });
});
