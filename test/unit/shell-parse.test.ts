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
    expect(b[0]!.redirects).toEqual([{ op: ">", kind: "file", target: "year.txt", fd: null, unresolved: false }]);
    // nested
    expect(programs('echo "$(basename "$(pwd)")"')).toEqual(["echo", "basename", "pwd"]);
  });

  it("subshells and brace groups, with redirects applied to the inner commands", () => {
    const c = cmds("(cd packages/app && npm test) 2>&1 | tee test.log");
    expect(c.map((x) => x.program)).toEqual(["cd", "npm", "tee"]);
    expect(c[1]!.redirects).toEqual([{ op: ">&", kind: "fd", target: "1", fd: 2, unresolved: false }]);
    expect(c.every((x) => x.inPipeline)).toBe(true);
    const g = cmds("{ npm run lint; npm test; } > ci.log");
    expect(g.map((x) => x.redirects)).toEqual([
      [{ op: ">", kind: "file", target: "ci.log", fd: null, unresolved: false }],
      [{ op: ">", kind: "file", target: "ci.log", fd: null, unresolved: false }],
    ]);
  });

  it("quoting and escapes are removed from values", () => {
    expect(cmds(`git commit -m "fix: handle 'empty' input"`)[0]!.args).toEqual(["commit", "-m", "fix: handle 'empty' input"]);
    expect(cmds("cat my\\ notes.txt 'a b.txt' $'tab\\there'")[0]!.args).toEqual(["my notes.txt", "a b.txt", "tab\there"]);
    expect(cmds('grep -rn "TODO;" src && echo done').map((x) => x.program)).toEqual(["grep", "echo"]);
  });

  it("redirects: output, append, input, stderr", () => {
    expect(cmds("npm test > out.log 2> err.log")[0]!.redirects).toEqual([
      { op: ">", kind: "file", target: "out.log", fd: null, unresolved: false },
      { op: ">", kind: "file", target: "err.log", fd: 2, unresolved: false },
    ]);
    expect(cmds("echo done >> build.log")[0]!.redirects).toEqual([{ op: ">>", kind: "file", target: "build.log", fd: null, unresolved: false }]);
    expect(cmds("wc -l < src/index.js")[0]!.redirects).toEqual([{ op: "<", kind: "file", target: "src/index.js", fd: null, unresolved: false }]);
    expect(cmds("node -p 1 <<< 'x'")[0]!.redirects).toEqual([{ op: "<<<", kind: "herestring", target: "x", fd: null, unresolved: false }]);
  });

  it("heredocs: delimiter recorded; unquoted bodies' substitutions are walked, quoted ones aren't", () => {
    const c = cmds("cat > CHANGELOG.md <<EOF\n## $(date +%F)\n- fixed tests\nEOF");
    expect(c[0]).toMatchObject({ program: "cat", args: [] });
    expect(c[0]!.redirects).toEqual([
      { op: ">", kind: "file", target: "CHANGELOG.md", fd: null, unresolved: false },
      { op: "<<", kind: "heredoc", target: "EOF", fd: null, unresolved: false },
    ]);
    expect(c[1]).toMatchObject({ program: "date", inSubstitution: true });
    const q = cmds("cat <<'EOF' > tpl.sh\necho $(not run)\nEOF");
    expect(q.map((x) => x.program)).toEqual(["cat"]);
    expect(q[0]!.redirects[0]).toEqual({ op: "<<", kind: "heredoc", target: "EOF", fd: null, unresolved: false });
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

describe("variables, ~, globs and brace expansion", () => {
  const opts = { cwd: "/home/alice/app", home: "/home/alice", oldpwd: "/home/alice" };
  const one = (c: string) => {
    const r = parseCommand(c, opts);
    if ("parseError" in r) throw new Error(r.parseError);
    return r.commands[0]!;
  };

  it("expands $HOME, ${HOME}, $PWD, $OLDPWD and ~ when known", () => {
    expect(one("echo $HOME").argWords).toEqual([{ value: "/home/alice", raw: "$HOME", unresolved: false }]);
    expect(one('ls "${HOME}/Downloads"').args).toEqual(["/home/alice/Downloads"]);
    expect(one("ls $PWD/src").args).toEqual(["/home/alice/app/src"]);
    expect(one("cd $OLDPWD").args).toEqual(["/home/alice"]);
    expect(one("ls ~ ~/notes").args).toEqual(["/home/alice", "/home/alice/notes"]);
  });

  it("quoted ~ is literal; ~user is left for classifyPath", () => {
    expect(one('ls "~/x"').argWords[0]).toEqual({ value: "~/x", raw: '"~/x"', unresolved: false });
    expect(one("ls ~bob/shared").args).toEqual(["~bob/shared"]);
  });

  it("marks other variables, substitutions, globs and braces unresolved", () => {
    const c = one('cp $SRC "${OUT:-dist}" src/*.js file?.txt [ab].md {a,b}.json "$(npm prefix)/x" plain.txt');
    expect(c.argWords.map((a) => [a.raw, a.unresolved])).toEqual([
      ["$SRC", true],
      ['"${OUT:-dist}"', true],
      ["src/*.js", true],
      ["file?.txt", true],
      ["[ab].md", true],
      ["{a,b}.json", true],
      ['"$(npm prefix)/x"', true],
      ["plain.txt", false],
    ]);
  });

  it("quoted glob characters are literal", () => {
    expect(one("git ls-files '*.js' \"src/*\"").argWords.map((a) => a.unresolved)).toEqual([false, false, false]);
  });

  it("without a cwd, $PWD is unresolved; redirect targets are marked too", () => {
    const r = parseCommand("echo hi > $PWD/out.txt 2> $LOGFILE") as { commands: SimpleCommand[] };
    expect(r.commands[0]!.redirects.map((x) => [x.target, x.unresolved])).toEqual([
      ["$PWD/out.txt", true],
      ["$LOGFILE", true],
    ]);
  });

  it("an unknown program word is flagged", () => {
    expect(one("$EDITOR README.md")).toMatchObject({ program: "$EDITOR", programUnresolved: true });
    expect(one("npm test").programUnresolved).toBe(false);
  });

  it("reassigning HOME makes later $HOME / ~ unknown", () => {
    const r = parseCommand("HOME=/tmp/h; ls ~ $HOME", opts) as { commands: SimpleCommand[] };
    expect(r.commands[1]!.argWords.map((a) => [a.value, a.unresolved])).toEqual([
      ["~", true],
      ["$HOME", true],
    ]);
    // a prefix assignment only affects that command's environment, not its own expansion
    expect(one("HOME=/x echo $HOME").args).toEqual(["/home/alice"]);
  });
});

describe("directory tracking: cd / pushd / popd", () => {
  const opts = { cwd: "/home/alice/app", home: "/home/alice" };
  const cwds = (c: string, o: object = opts) => {
    const r = parseCommand(c, o);
    if ("parseError" in r) throw new Error(r.parseError);
    return r.commands.map((x) => [x.program, x.cwd]);
  };

  it("cd src && ls / cd .. && git status", () => {
    expect(cwds("cd src && ls")).toEqual([["cd", "/home/alice/app"], ["ls", "/home/alice/app/src"]]);
    expect(cwds("cd .. && git status")).toEqual([["cd", "/home/alice/app"], ["git", "/home/alice"]]);
    expect(cwds("cd packages/web; npm test; cd ../api && npm test")).toEqual([
      ["cd", "/home/alice/app"],
      ["npm", "/home/alice/app/packages/web"],
      ["cd", "/home/alice/app/packages/web"],
      ["npm", "/home/alice/app/packages/api"],
    ]);
  });

  it("absolute, ~, bare cd (home), $HOME, and -- / -P options", () => {
    expect(cwds("cd /var/log && ls")[1]).toEqual(["ls", "/var/log"]);
    expect(cwds("cd ~/notes && ls")[1]).toEqual(["ls", "/home/alice/notes"]);
    expect(cwds("cd && ls")[1]).toEqual(["ls", "/home/alice"]);
    expect(cwds("cd $HOME/x && ls")[1]).toEqual(["ls", "/home/alice/x"]);
    expect(cwds("cd -P -- build && ls")[1]).toEqual(["ls", "/home/alice/app/build"]);
  });

  it("unknown targets: variables, cd -, substitutions", () => {
    expect(cwds("cd $DIR && ls")[1]).toEqual(["ls", null]);
    expect(cwds("cd - && ls")[1]).toEqual(["ls", null]);
    expect(cwds('cd "$(git rev-parse --show-toplevel)" && npm test')[2]).toEqual(["npm", null]);
    // an absolute cd after an unknown one is known again
    expect(cwds("cd $DIR; cd /tmp; ls")[2]).toEqual(["ls", "/tmp"]);
    // a relative cd after an unknown one stays unknown
    expect(cwds("cd $DIR; cd src; ls")[2]).toEqual(["ls", null]);
  });

  it("subshells, pipeline stages, substitutions and background jobs don't leak their cd", () => {
    expect(cwds("(cd src && ls) && pwd")).toEqual([
      ["cd", "/home/alice/app"],
      ["ls", "/home/alice/app/src"],
      ["pwd", "/home/alice/app"],
    ]);
    expect(cwds("cd src | cat; ls").at(-1)).toEqual(["ls", "/home/alice/app"]);
    expect(cwds("echo $(cd /tmp && pwd); ls").at(-1)).toEqual(["ls", "/home/alice/app"]);
    expect(cwds("cd /tmp & ls").at(-1)).toEqual(["ls", "/home/alice/app"]);
  });

  it("brace groups share the shell, so their cd does persist", () => {
    expect(cwds("{ cd src; }; ls").at(-1)).toEqual(["ls", "/home/alice/app/src"]);
  });

  it("a cd inside if/for bodies makes the cwd afterwards unknown", () => {
    expect(cwds("if [ -d src ]; then cd src; fi; ls").at(-1)).toEqual(["ls", null]);
    expect(cwds("for d in a b; do cd $d; done; ls").at(-1)).toEqual(["ls", null]);
    // ...but a body without cd leaves it known
    expect(cwds("if true; then npm test; fi; ls").at(-1)).toEqual(["ls", "/home/alice/app"]);
    // commands inside the body see the body's cwd
    expect(cwds("if true; then cd src; ls; fi")).toContainEqual(["ls", "/home/alice/app/src"]);
  });

  it("pushd / popd", () => {
    expect(cwds("pushd src && npm test && popd && ls")).toEqual([
      ["pushd", "/home/alice/app"],
      ["npm", "/home/alice/app/src"],
      ["popd", "/home/alice/app/src"],
      ["ls", "/home/alice/app"],
    ]);
    expect(cwds("popd; ls").at(-1)).toEqual(["ls", null]); // empty stack: unknown
    expect(cwds("pushd +1; ls").at(-1)).toEqual(["ls", null]);
  });

  it("$PWD / $OLDPWD follow cd", () => {
    const r = parseCommand("cd src && ls $PWD $OLDPWD", opts) as { commands: SimpleCommand[] };
    expect(r.commands[1]!.args).toEqual(["/home/alice/app/src", "/home/alice/app"]);
  });

  it("without a starting cwd, relative cds stay unknown and absolute ones are known", () => {
    expect(cwds("cd src && ls", {})).toEqual([["cd", null], ["ls", null]]);
    expect(cwds("cd /srv/app && ls", {})[1]).toEqual(["ls", "/srv/app"]);
  });

  it("`sudo cd` doesn't change the shell's directory; `command cd` does", () => {
    expect(cwds("sudo cd /root; ls").at(-1)).toEqual(["ls", "/home/alice/app"]);
    expect(cwds("command cd src; ls").at(-1)).toEqual(["ls", "/home/alice/app/src"]);
  });
});

describe("nested shells: bash/sh/zsh/dash -c and eval", () => {
  const opts = { cwd: "/home/alice/app", home: "/home/alice" };
  const all = (c: string) => {
    const r = parseCommand(c, opts);
    if ("parseError" in r) throw new Error(r.parseError);
    return r.commands;
  };

  it("bash -c 'npm test && npm run build' includes the inner commands, marked nested", () => {
    const c = all("bash -c 'npm test && npm run build'");
    expect(c.map((x) => [x.program, x.args, x.nested, x.depth])).toEqual([
      ["bash", ["-c", "npm test && npm run build"], false, 0],
      ["npm", ["test"], true, 1],
      ["npm", ["run", "build"], true, 1],
    ]);
    expect(c[0]!.unparsedNested).toBe(false);
  });

  it("sh -c, zsh -c, dash -c, combined flags (-lc, -ec) and /bin/sh", () => {
    expect(all('sh -c "ls -la"').map((x) => x.program)).toEqual(["sh", "ls"]);
    expect(all("zsh -c 'git status'").map((x) => x.program)).toEqual(["zsh", "git"]);
    expect(all("dash -c 'pwd'").map((x) => x.program)).toEqual(["dash", "pwd"]);
    expect(all("bash -lc 'node -v'").map((x) => x.program)).toEqual(["bash", "node"]);
    expect(all("/bin/sh -ec 'make && make test'").map((x) => x.program)).toEqual(["/bin/sh", "make", "make"]);
    expect(all("bash -o pipefail -c 'npm test | tee t.log'").slice(1).map((x) => [x.program, x.inPipeline])).toEqual([
      ["npm", true],
      ["tee", true],
    ]);
  });

  it("bash without -c (a script file, or interactive) is not nested", () => {
    expect(all("bash scripts/build.sh").map((x) => x.program)).toEqual(["bash"]);
    expect(all("bash --version").map((x) => x.program)).toEqual(["bash"]);
  });

  it("wrapped nested shells and nested shells inside chains / pipelines", () => {
    const c = all("sudo -u dev bash -c 'npm ci' && echo done");
    expect(c.map((x) => [x.program, x.depth])).toEqual([["bash", 0], ["npm", 1], ["echo", 0]]);
    expect(c[0]!.wrappers).toEqual(["sudo"]);
    expect(all("timeout 60 sh -c 'npm test'").map((x) => x.program)).toEqual(["sh", "npm"]);
  });

  it("eval parses its joined arguments", () => {
    expect(all("eval 'npm test'").map((x) => [x.program, x.nested])).toEqual([["eval", false], ["npm", true]]);
    expect(all("eval git status").map((x) => [x.program, x.args])).toEqual([["eval", ["git", "status"]], ["git", ["status"]]]);
  });

  it("the inner shell starts in the current directory; its cd doesn't leak, but eval's does", () => {
    expect(all("cd src && bash -c 'cd lib && ls' && pwd").map((x) => [x.program, x.cwd])).toEqual([
      ["cd", "/home/alice/app"],
      ["bash", "/home/alice/app/src"],
      ["cd", "/home/alice/app/src"], // nested commands follow their parent
      ["ls", "/home/alice/app/src/lib"],
      ["pwd", "/home/alice/app/src"],
    ]);
    expect(all("eval 'cd src'; ls").at(-1)).toMatchObject({ program: "ls", cwd: "/home/alice/app/src" });
  });

  it("inner $HOME expands in the inner shell (single quotes defer it)", () => {
    expect(all("bash -c 'ls $HOME'")[1]!.args).toEqual(["/home/alice"]);
  });

  it(`depth is capped at 3; the 4th level is returned with unparsedNested`, () => {
    const c = all(`bash -c "sh -c 'dash -c \\"zsh -c ls\\"'"`);
    expect(c.map((x) => [x.program, x.depth, x.unparsedNested])).toEqual([
      ["bash", 0, false],
      ["sh", 1, false],
      ["dash", 2, false],
      ["zsh", 3, true],
    ]);
    expect(c[3]!.nestedReason).toMatch(/deeper than 3/);
  });

  it("scripts built from variables or substitutions are not guessed at", () => {
    const c = all('bash -c "$CMD"');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ program: "bash", unparsedNested: true });
    expect(all('eval "$(ssh-agent -s)"')[0]).toMatchObject({ program: "eval", unparsedNested: true });
  });

  it("a nested script that fails to parse is marked, the outer parse still succeeds", () => {
    const c = all(`bash -c 'echo "unterminated'`);
    expect(c[0]).toMatchObject({ program: "bash", unparsedNested: true });
    expect(c[0]!.nestedReason).toMatch(/nested parse error/);
  });
});
