import { describe, expect, it } from "vitest";
import { classifyPath, resolvePath } from "../../src/shell/paths.js";

const home = "/home/alice";
const root = "/home/alice/code/app";
const cls = (p: string, cwd = root) => classifyPath(p, cwd, root, home);

describe("resolvePath", () => {
  it("expands ~ and ~/, resolves relative and .. segments", () => {
    expect(resolvePath("~", root, home)).toBe("/home/alice");
    expect(resolvePath("~/notes.md", root, home)).toBe("/home/alice/notes.md");
    expect(resolvePath("src/index.js", root, home)).toBe("/home/alice/code/app/src/index.js");
    expect(resolvePath("./dist/../src", root, home)).toBe("/home/alice/code/app/src");
    expect(resolvePath("/etc/../usr/bin", root, home)).toBe("/usr/bin");
    expect(resolvePath("~bob/x", root, home)).toBe("/home/alice/code/app/~bob/x"); // ~user isn't expanded
  });
});

describe("classifyPath", () => {
  it("inside-project: relative, ./, nested, the root itself, absolute", () => {
    for (const p of ["src/index.js", "./dist", "node_modules", ".", "/home/alice/code/app/test/a.test.js", "src/../package.json"]) {
      expect(cls(p), p).toBe("inside-project");
    }
    expect(cls("index.js", "/home/alice/code/app/src")).toBe("inside-project");
    expect(cls("..", "/home/alice/code/app/src")).toBe("inside-project");
  });

  it("home: ~, ~/..., and .. that climbs out of the project into home", () => {
    expect(cls("~")).toBe("home");
    expect(cls("~/Downloads")).toBe("home");
    expect(cls("..")).toBe("home"); // /home/alice/code
    expect(cls("../other-app")).toBe("home");
    expect(cls("/home/alice/.config/app.json")).toBe("home");
  });

  it("a sibling directory whose name starts with the project name is not inside", () => {
    expect(cls("/home/alice/code/app-old")).toBe("home");
    expect(cls("../app-old")).toBe("home");
  });

  it("system: /, OS directories, other users' homes", () => {
    for (const p of ["/", "/etc/hosts", "/usr/local/bin", "/var/log", "/home", "/home/bob", "/Users/bob", "/System/Library", "/dev/null"]) {
      expect(cls(p), p).toBe("system");
    }
    expect(cls("../../../..")).toBe("system"); // climbs to /
  });

  it("outside-project: scratch dirs and other mounts", () => {
    for (const p of ["/tmp", "/tmp/build-cache", "/var/tmp/x", "/mnt/data", "/media/usb/project", "/workspace/other"]) {
      expect(cls(p), p).toBe("outside-project");
    }
  });

  it("near-miss pairs resolve to different classes", () => {
    expect(cls("./tmp")).toBe("inside-project");
    expect(cls("/tmp")).toBe("outside-project");
    expect(cls("~/tmp")).toBe("home");
  });

  it("project root outside home (e.g. /workspace) still classifies inside first", () => {
    expect(classifyPath("src", "/workspace/app", "/workspace/app", home)).toBe("inside-project");
    expect(classifyPath("../lib", "/workspace/app", "/workspace/app", home)).toBe("outside-project");
  });
});
