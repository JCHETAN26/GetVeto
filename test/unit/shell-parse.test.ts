import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCommand, type SimpleCommand } from "../../src/shell/parse.js";
import { loadFixtures, REPO } from "../helpers.js";

function cmds(command: string): SimpleCommand[] {
  const r = parseCommand(command);
  if ("parseError" in r) throw new Error(`unexpected parseError: ${r.parseError}`);
  return r.commands;
}
const programs = (command: string) => cmds(command).map((c) => c.program);

describe("parseCommand on commands from REAL captured Bash events", () => {
  const real = loadFixtures().filter((f) => f.event.hook_event_name === "PreToolUse" && f.event.tool_name === "Bash");
  const command = (prefix: string) =>
    (real.find((f) => f.name.startsWith(prefix))!.event.tool_input as { command: string }).command;

  it("every real Bash command parses without error", () => {
    expect(real.length).toBeGreaterThan(0);
    for (const f of real) {
      const r = parseCommand((f.event.tool_input as { command: string }).command);
      expect(r, f.name).not.toHaveProperty("parseError");
    }
  });

  it("`cat <file>; ls -la <dir>` -> two commands", () => {
    const c = cmds(command("03-"));
    expect(c.map((x) => x.program)).toEqual(["cat", "ls"]);
    expect(c[1]!.flags).toEqual(["-la"]);
    expect(c[1]!.args).toEqual(["-la", "/REDACTED_PROJECT"]);
  });

  it("the real sed edit chain: single quotes with | and a backtick-free template literal stay one argument", () => {
    const c = cmds(command("09-"));
    expect(c.map((x) => x.program)).toEqual(["sed", "cat", "node"]);
    expect(c[0]!.args).toEqual(["-i", 's|return "Hello, " + name;|return `Hello, ${name}`;|', "greet.js"]);
    expect(c[0]!.flags).toEqual(["-i"]);
    expect(c.every((x) => !x.inPipeline && !x.inSubstitution)).toBe(true);
  });

  it("git status / touch", () => {
    expect(cmds(command("07-"))[0]).toMatchObject({ program: "git", args: ["status"], flags: [] });
    expect(cmds(command("15-"))[0]).toMatchObject({ program: "touch", args: ["denied-proof.txt"] });
  });
});

describe("parseCommand on everyday dev commands", () => {
  it("simple commands, args and flags", () => {
    expect(cmds("ls -la")[0]).toMatchObject({ program: "ls", args: ["-la"], flags: ["-la"], wrappers: [] });
    expect(cmds("git log --oneline -5")[0]).toMatchObject({ program: "git", args: ["log", "--oneline", "-5"], flags: ["--oneline", "-5"] });
    expect(cmds("npm test")[0]).toMatchObject({ program: "npm", args: ["test"], flags: [] });
    expect(cmds("npm run build")[0]).toMatchObject({ program: "npm", args: ["run", "build"] });
    expect(cmds("cat src/index.js")[0]).toMatchObject({ program: "cat", args: ["src/index.js"] });
  });

  it("flags stop at --", () => {
    expect(cmds("git checkout -b feat -- src/a.js")[0]!.flags).toEqual(["-b"]);
    expect(cmds("grep -n -- -foo README.md")[0]!.flags).toEqual(["-n"]);
  });

  it("chains: ; && || keep every command, in order", () => {
    expect(programs("sed -i 's/a/b/' file.js && cat file.js && node file.js")).toEqual(["sed", "cat", "node"]);
    expect(programs("npm ci || npm install; npm test")).toEqual(["npm", "npm", "npm"]);
    const c = cmds("rm -rf node_modules && npm install");
    expect(c[0]).toMatchObject({ program: "rm", args: ["-rf", "node_modules"], flags: ["-rf"] });
    expect(c[1]).toMatchObject({ program: "npm", args: ["install"] });
  });

  it("pipelines mark every stage", () => {
    const c = cmds("git log --oneline | head -5");
    expect(c.map((x) => [x.program, x.inPipeline])).toEqual([["git", true], ["head", true]]);
    expect(cmds("git log --oneline -5")[0]!.inPipeline).toBe(false);
    // only the pipeline in a chain is marked
    expect(cmds("npm test && git diff | cat").map((x) => x.inPipeline)).toEqual([false, true, true]);
  });

  it("env-var prefixes are assignments, not the program", () => {
    expect(cmds("FOO=1 npm test")[0]).toMatchObject({ program: "npm", args: ["test"], assignments: ["FOO"] });
    expect(cmds("NODE_ENV=production DEBUG= npm run build")[0]).toMatchObject({ program: "npm", assignments: ["NODE_ENV", "DEBUG"] });
    expect(cmds("VERSION=1.2.3")[0]).toMatchObject({ program: null, assignments: ["VERSION"] });
  });

  it("$(...) and backtick substitutions are walked into", () => {
    const c = cmds('echo "$(git rev-parse HEAD)"');
    expect(c[0]).toMatchObject({ program: "echo", inSubstitution: false });
    expect(c[1]).toMatchObject({ program: "git", args: ["rev-parse", "HEAD"], inSubstitution: true });
    const b = cmds("echo `date +%Y` > year.txt");
    expect(b.map((x) => [x.program, x.inSubstitution])).toEqual([["echo", false], ["date", true]]);
    expect(b[0]!.redirects).toEqual([{ op: ">", kind: "file", target: "year.txt", fd: null }]);
    // nested
    expect(programs('echo "$(basename "$(pwd)")"')).toEqual(["echo", "basename", "pwd"]);
  });

  it("subshells and brace groups, with redirects applied to the inner commands", () => {
    const c = cmds("(cd packages/app && npm test) 2>&1 | tee test.log");
    expect(c.map((x) => x.program)).toEqual(["cd", "npm", "tee"]);
    expect(c[1]!.redirects).toEqual([{ op: ">&", kind: "fd", target: "1", fd: 2 }]);
    expect(c.every((x) => x.inPipeline)).toBe(true);
    const g = cmds("{ npm run lint; npm test; } > ci.log");
    expect(g.map((x) => x.redirects)).toEqual([
      [{ op: ">", kind: "file", target: "ci.log", fd: null }],
      [{ op: ">", kind: "file", target: "ci.log", fd: null }],
    ]);
  });

  it("quoting and escapes are removed from values", () => {
    expect(cmds(`git commit -m "fix: handle 'empty' input"`)[0]!.args).toEqual(["commit", "-m", "fix: handle 'empty' input"]);
    expect(cmds("cat my\\ notes.txt 'a b.txt' $'tab\\there'")[0]!.args).toEqual(["my notes.txt", "a b.txt", "tab\there"]);
    expect(cmds('grep -rn "TODO;" src && echo done').map((x) => x.program)).toEqual(["grep", "echo"]);
  });

  it("redirects: output, append, input, stderr", () => {
    expect(cmds("npm test > out.log 2> err.log")[0]!.redirects).toEqual([
      { op: ">", kind: "file", target: "out.log", fd: null },
      { op: ">", kind: "file", target: "err.log", fd: 2 },
    ]);
    expect(cmds("echo done >> build.log")[0]!.redirects).toEqual([{ op: ">>", kind: "file", target: "build.log", fd: null }]);
    expect(cmds("wc -l < src/index.js")[0]!.redirects).toEqual([{ op: "<", kind: "file", target: "src/index.js", fd: null }]);
    expect(cmds("node -p 1 <<< 'x'")[0]!.redirects).toEqual([{ op: "<<<", kind: "herestring", target: "x", fd: null }]);
  });

  it("heredocs: delimiter recorded; unquoted bodies' substitutions are walked, quoted ones aren't", () => {
    const c = cmds("cat > CHANGELOG.md <<EOF\n## $(date +%F)\n- fixed tests\nEOF");
    expect(c[0]).toMatchObject({ program: "cat", args: [] });
    expect(c[0]!.redirects).toEqual([
      { op: ">", kind: "file", target: "CHANGELOG.md", fd: null },
      { op: "<<", kind: "heredoc", target: "EOF", fd: null },
    ]);
    expect(c[1]).toMatchObject({ program: "date", inSubstitution: true });
    const q = cmds("cat <<'EOF' > tpl.sh\necho $(not run)\nEOF");
    expect(q.map((x) => x.program)).toEqual(["cat"]);
    expect(q[0]!.redirects[0]).toEqual({ op: "<<", kind: "heredoc", target: "EOF", fd: null });
  });

  it("wrappers are stripped and recorded: sudo, env, xargs, time, nohup", () => {
    expect(cmds("sudo -u postgres psql -l")[0]).toMatchObject({ program: "psql", args: ["-l"], wrappers: ["sudo"] });
    expect(cmds("env NODE_ENV=test npm test")[0]).toMatchObject({ program: "npm", assignments: ["NODE_ENV"], wrappers: ["env"] });
    expect(cmds("time npm run build")[0]).toMatchObject({ program: "npm", wrappers: ["time"] });
    expect(cmds("/usr/bin/time -v npm test")[0]).toMatchObject({ program: "npm", wrappers: ["time"] });
    expect(cmds("nohup npm start > server.log &")[0]).toMatchObject({ program: "npm", args: ["start"], wrappers: ["nohup"] });
    const x = cmds("git ls-files '*.js' | xargs -n 50 npx prettier --check");
    expect(x[1]).toMatchObject({ program: "npx", args: ["prettier", "--check"], wrappers: ["xargs"], inPipeline: true });
    expect(cmds("sudo env A=1 nohup node app.js")[0]).toMatchObject({ program: "node", wrappers: ["sudo", "env", "nohup"], assignments: ["A"] });
  });

  it("never throws; malformed input returns { parseError }", () => {
    for (const bad of ['echo "unterminated', "if true; then", "echo $(", ")"]) {
      const r = parseCommand(bad);
      expect(r, bad).toHaveProperty("parseError");
      expect(typeof (r as { parseError: string }).parseError).toBe("string");
    }
    expect(parseCommand(42 as unknown as string)).toEqual({ parseError: "command is not a string" });
    expect(parseCommand("")).toEqual({ commands: [] });
  });

  it("an unterminated heredoc is accepted, like bash (which only warns and runs it)", () => {
    expect(cmds("cat <<EOF\nno end")[0]).toMatchObject({ program: "cat", redirects: [{ kind: "heredoc", target: "EOF" }] });
  });
});

describe("built module: lazy import has no side effects", () => {
  it("importing dist/shell/parse.js prints nothing and works", () => {
    const mod = join(REPO, "dist", "shell", "parse.js");
    const r = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `const m = await import(${JSON.stringify(mod)}); process.exitCode = m.parseCommand("ls -la").commands[0].program === "ls" ? 0 : 3;`],
      { encoding: "utf8" },
    );
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);
  });
});

describe("more wrappers: timeout, nice, command, exec, stdbuf, ionice", () => {
  it("strips each wrapper and its options / positional args", () => {
    expect(cmds("timeout 30 npm test")[0]).toMatchObject({ program: "npm", args: ["test"], wrappers: ["timeout"] });
    expect(cmds("timeout -s KILL --kill-after 5 2m npm run e2e")[0]).toMatchObject({ program: "npm", args: ["run", "e2e"], wrappers: ["timeout"] });
    expect(cmds("nice -n 10 npm run build")[0]).toMatchObject({ program: "npm", wrappers: ["nice"] });
    expect(cmds("nice make -j8")[0]).toMatchObject({ program: "make", args: ["-j8"], wrappers: ["nice"] });
    expect(cmds("command git status")[0]).toMatchObject({ program: "git", args: ["status"], wrappers: ["command"] });
    expect(cmds("exec node server.js")[0]).toMatchObject({ program: "node", wrappers: ["exec"] });
    expect(cmds("stdbuf -oL npm test | tee t.log")[0]).toMatchObject({ program: "npm", wrappers: ["stdbuf"], inPipeline: true });
    expect(cmds("stdbuf -o L npm test")[0]).toMatchObject({ program: "npm", wrappers: ["stdbuf"] });
    expect(cmds("ionice -c 3 npm run build")[0]).toMatchObject({ program: "npm", wrappers: ["ionice"] });
  });

  it("stacks wrappers in order", () => {
    expect(cmds("sudo nice -n 5 timeout 60 env CI=1 npm test")[0]).toMatchObject({
      program: "npm",
      wrappers: ["sudo", "nice", "timeout", "env"],
      assignments: ["CI"],
    });
  });

  it("`command -v` / `-V` is a lookup, not a wrapper", () => {
    expect(cmds("command -v npm")[0]).toMatchObject({ program: "command", args: ["-v", "npm"], wrappers: [] });
    expect(cmds("command -V git")[0]).toMatchObject({ program: "command", wrappers: [] });
  });

  it("a wrapper with nothing to wrap stays the program", () => {
    expect(cmds("timeout")[0]).toMatchObject({ program: "timeout", wrappers: [] });
    expect(cmds("nice")[0]).toMatchObject({ program: "nice", wrappers: [] });
    expect(cmds("sudo")[0]).toMatchObject({ program: "sudo", wrappers: [] });
    expect(cmds("exec > build.log")[0]).toMatchObject({ program: null, wrappers: ["exec"], redirects: [{ op: ">", target: "build.log" }] });
  });
});
