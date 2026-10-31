// Reports `veto hook` wall-clock latency: spawn of the built CLI -> process exit, payload on stdin.
// This includes Node.js startup, which is the cost Claude Code actually pays per tool call.
import { describe, expect, it } from "vitest";
import { loadFixtures, runCli, tempProject } from "../helpers.js";

const RUNS = 30;

describe("veto hook latency", () => {
  it(`reports p50/p95/max over ${RUNS} runs`, async () => {
    const root = tempProject();
    const f = loadFixtures()[0]!;
    await runCli(["hook"], { cwd: root, stdin: f.raw, env: { CLAUDE_PROJECT_DIR: root } }); // warm FS cache
    const ms: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const r = await runCli(["hook"], { cwd: root, stdin: f.raw, env: { CLAUDE_PROJECT_DIR: root } });
      expect(r.code).toBe(0);
      ms.push(r.ms);
    }
    ms.sort((a, b) => a - b);
    const p = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))]!;
    const report = `veto hook latency (${RUNS} runs, ${process.version}, ${f.source} fixture): p50=${p(0.5).toFixed(1)}ms p95=${p(0.95).toFixed(1)}ms max=${ms[ms.length - 1]!.toFixed(1)}ms`;
    console.log(`[timing] ${report}`);
    // Generous ceiling so CI noise doesn't flake; the 50ms target is tracked from the printed p50.
    expect(p(0.5)).toBeLessThan(500);
  });
});
