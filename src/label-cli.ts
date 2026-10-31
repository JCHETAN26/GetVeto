// `veto label [--from <project-dir>] [--to <veto-repo-dir>]`: interactive labeling.
// In a terminal: single keypresses. With piped stdin: one answer per line (used by tests).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  buildExample,
  CATEGORIES,
  loadCandidates,
  parsePlaybook,
  pendingCandidates,
  suggestScenario,
  type Candidate,
  type Category,
  type Verdict,
} from "./label.js";
import { formatTime } from "./logview.js";

export const LABEL_DIR = join("test", "fixtures", "redteam");

interface Input {
  key(prompt: string): Promise<string>;
  line(prompt: string): Promise<string>;
  close(): void;
}

/** Raw-mode single keys for line()/key() in a real terminal. */
function ttyInput(out: NodeJS.WriteStream): Input {
  const stdin = process.stdin;
  return {
    key(prompt) {
      out.write(prompt);
      return new Promise((res) => {
        stdin.setRawMode(true);
        stdin.resume();
        stdin.once("data", (d: Buffer) => {
          stdin.setRawMode(false);
          stdin.pause();
          const ch = d.toString("utf8");
          const k = ch === "\u0003" || ch === "\u0004" ? "q" : ch[0] ?? ""; // Ctrl-C / Ctrl-D -> quit
          out.write((k === "\r" ? "" : k) + "\n");
          res(k.toLowerCase());
        });
      });
    },
    line(prompt) {
      return new Promise((res) => {
        const rl = createInterface({ input: stdin, output: out, terminal: true });
        rl.question(prompt, (a) => {
          rl.close();
          res(a);
        });
      });
    },
    close() {
      stdin.pause();
    },
  };
}

/** Piped stdin: each answer is one line; EOF answers "q" to keys and "" to lines. */
async function pipedInput(out: NodeJS.WritableStream): Promise<Input> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
  let i = 0;
  const next = () => (i < lines.length ? lines[i++]! : null);
  return {
    async key(prompt) {
      out.write(prompt);
      const l = next();
      const k = l === null ? "q" : (l.trim()[0] ?? "").toLowerCase();
      out.write(k + "\n");
      return k;
    },
    async line(prompt) {
      out.write(prompt);
      const l = next() ?? "";
      out.write(l + "\n");
      return l;
    },
    close() {},
  };
}

/** Default --to: the repo this CLI was built from, if it is a GetVeto checkout. */
export function defaultRepoDir(): string | null {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { name?: string };
    if (pkg.name === "getveto" && existsSync(join(repo, "test"))) return repo;
  } catch {
    /* not a checkout */
  }
  return null;
}

function show(c: Candidate, idx: number, total: number, suggested: number | null, out: NodeJS.WritableStream) {
  const bar = "─".repeat(72);
  const outcome = {
    ran: "ran (PostToolUse logged)",
    failed: "FAILED (PostToolUseFailure logged)",
    "no-post": "no post event: denied at the prompt, blocked, or interrupted",
  }[c.outcome];
  out.write(`\n${bar}\n[${idx}/${total}]  ${formatTime(c.loggedAt)}   ${c.toolName}   (${outcome})\n${bar}\n`);
  out.write(`${c.toolName === "Bash" || c.toolName === "PowerShell" ? "command" : "target"}:\n`);
  for (const l of c.detail.split("\n")) out.write(`    ${l}\n`);
  if (c.prompt !== null) {
    const p = c.prompt.length > 600 ? c.prompt.slice(0, 600) + " …" : c.prompt;
    out.write(`prompt:\n${p.split("\n").map((l) => `    ${l}`).join("\n")}\n`);
  } else out.write("prompt:  (not logged)\n");
  if (suggested !== null) out.write(`playbook: matches scenario #${suggested}\n`);
}

const CATEGORY_MENU = CATEGORIES.map((c, i) => `${i + 1}=${c}`).join("  ");

export async function runLabel(argv: string[]): Promise<number> {
  const out = process.stdout;
  let from = process.cwd();
  let to: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from" || a === "--to") {
      const v = argv[++i];
      if (!v) {
        process.stderr.write(`veto: ${a} needs a directory\n`);
        return 1;
      }
      if (a === "--from") from = resolve(v);
      else to = resolve(v);
    } else {
      process.stderr.write(`veto: unknown option for label: ${a}\n`);
      return 1;
    }
  }
  to ??= defaultRepoDir();
  if (!to) {
    process.stderr.write("veto: pass --to <veto-repo-dir> (where labeled examples are saved)\n");
    return 1;
  }
  const logPath = join(from, ".veto", "log.jsonl");
  if (!existsSync(logPath)) {
    process.stderr.write(`veto: no log at ${logPath}\n`);
    return 1;
  }
  const saveDir = join(to, LABEL_DIR);
  mkdirSync(saveDir, { recursive: true });
  const labeled = new Set(readdirSync(saveDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));
  const all = loadCandidates(readFileSync(logPath, "utf8"));
  const todo = pendingCandidates(all, labeled);
  let playbook = new Map<number, string>();
  try {
    playbook = parsePlaybook(readFileSync(join(to, "redteam", "PLAYBOOK.md"), "utf8"));
  } catch {
    /* no playbook: no suggestions */
  }

  out.write(`${all.length} PreToolUse event(s) in ${logPath}; ${all.length - todo.length} already labeled; ${todo.length} to go.\n`);
  out.write(`Saving to ${saveDir}\n`);
  if (todo.length === 0) return 0;

  let username: string | undefined;
  try {
    username = userInfo().username;
  } catch {
    /* ignore */
  }
  const redact = { homeDir: homedir(), username, projectDir: from };
  const input = process.stdin.isTTY ? ttyInput(process.stdout) : await pipedInput(out);
  let saved = 0;
  let skipped = 0;
  try {
    for (let i = 0; i < todo.length; i++) {
      const c = todo[i]!;
      const suggested = suggestScenario(c.prompt, playbook);
      show(c, i + 1, todo.length, suggested, out);

      let verdict: Verdict | null = null;
      for (;;) {
        const k = await input.key("verdict  [a]llow  [f]lag  [s]kip  [q]uit: ");
        if (k === "q") {
          out.write(`\nStopped. ${saved} saved, ${skipped} skipped. Run \`veto label\` again to resume.\n`);
          return 0;
        }
        if (k === "s") break;
        if (k === "a") verdict = "allow";
        else if (k === "f") verdict = "flag";
        if (verdict) break;
      }
      if (!verdict) {
        skipped++;
        continue;
      }

      let category: Category | null = null;
      while (!category) {
        const k = await input.key(`category ${CATEGORY_MENU}: `);
        if (k === "q") {
          out.write(`\nStopped before saving this one. ${saved} saved. Run \`veto label\` again to resume.\n`);
          return 0;
        }
        const n = Number(k);
        if (Number.isInteger(n) && n >= 1 && n <= CATEGORIES.length) category = CATEGORIES[n - 1]!;
      }

      let scenario: number | null = suggested;
      for (;;) {
        const hint = suggested !== null ? ` [Enter = ${suggested}, - = none]` : " [Enter = none]";
        const a = (await input.line(`scenario number${hint}: `)).trim();
        if (a === "") break;
        if (a === "-") {
          scenario = null;
          break;
        }
        const n = Number(a);
        if (Number.isInteger(n) && n > 0) {
          scenario = n;
          break;
        }
        out.write("  enter a positive whole number, '-' for none, or Enter\n");
      }
      const note = (await input.line("note (optional, one line): ")).replace(/[\r\n]+/g, " ").trim();

      const example = buildExample(c, { verdict, category, note, scenario }, redact, new Date());
      const file = join(saveDir, `${c.id}.json`);
      // "wx": never overwrite. A second labeler (or a rerun) can't double-label the same call.
      try {
        writeFileSync(file, JSON.stringify(example, null, 2) + "\n", { flag: "wx" });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        out.write(`already labeled (another run saved ${c.id} first); not overwriting\n`);
        skipped++;
        continue;
      }
      saved++;
      out.write(`saved ${join(LABEL_DIR, `${c.id}.json`)}  (${verdict}, ${category}${scenario ? `, #${scenario}` : ""})\n`);
    }
  } finally {
    input.close();
  }
  out.write(`\nDone. ${saved} saved, ${skipped} skipped.\n`);
  return 0;
}
