import { describe, expect, it } from "vitest";
import { outsideProject } from "../../src/rules/file-tools/outside-project.js";
import { loadFixtures } from "../helpers.js";
import { ROOT, sev, toolCtx } from "../rule-helpers.js";

const s = (tool: string, file_path: string, cwd?: string | null) => sev(outsideProject.check(toolCtx(tool, { file_path, content: "x" }, { cwd })));

describe("file-tools/outside-project", () => {
  it("near-miss: writing inside the project (fine) vs ~/notes.md (high) vs /tmp (medium)", () => {
    expect(s("Write", `${ROOT}/src/index.js`)).toBeNull();
    expect(s("Write", "/home/alice/notes.md")).toBe("high");
    expect(s("Write", "/tmp/scratch.txt")).toBe("medium");
  });

  it("all write tools; system paths are high; Read is not a write", () => {
    expect(s("Edit", "/etc/hosts")).toBe("high");
    expect(s("MultiEdit", "/home/alice/.bashrc")).toBe("high");
    expect(sev(outsideProject.check(toolCtx("NotebookEdit", { notebook_path: "/home/alice/other/nb.ipynb" })))).toBe("high");
    expect(s("Read", "/etc/hosts")).toBeNull();
    expect(s("Write", "/home/alice/code/app-old/x.js")).toBe("high"); // sibling with the same prefix
  });

  it("a relative path with no cwd is unknown (medium)", () => {
    expect(s("Write", "notes.md", null)).toBe("medium");
  });

  it("the real captured Edit fixture (inside its project) is not flagged", () => {
    for (const f of loadFixtures().filter((x) => x.event.tool_name === "Edit" && x.event.hook_event_name === "PreToolUse")) {
      const ev = f.event as { tool_input: Record<string, unknown>; cwd: string };
      expect(outsideProject.check(toolCtx("Edit", ev.tool_input, { cwd: ev.cwd, root: ev.cwd }))).toEqual([]);
    }
  });
});
