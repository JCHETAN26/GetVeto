// A shell command that reads the contents of a secret-looking file (the shared list in
// ../secret-paths.ts): content readers (cat, head, grep, sed, base64, ...), copies (cp, scp,
// rsync sources), input redirection (< .env), and git history (git show rev:path,
// git show/log -p/diff -- path). Medium.
// Only resolved words count: a variable, glob or substitution never triggers this rule.
import { basename, sep } from "node:path";
import type { Arg, SimpleCommand } from "../../shell/parse.js";
import { resolvePath } from "../../shell/paths.js";
import { gitCall } from "../git.js";
import { secretLooking } from "../secret-paths.js";
import type { Finding, Rule, RuleContext } from "../types.js";

const ID = "secret-access/shell-read";

interface Spec {
  /** Short options that take a value (in the same word, -n5, or the next one, -n 5). */
  short: string;
  /** Long options that take the next word as their value (when written without "="). */
  long: string[];
}

interface Walked {
  /** Options seen, with their values ("-e" -> "PORT"). */
  opts: { name: string; value?: Arg }[];
  operands: Arg[];
}

/** Split words into options (with values) and operands, given which options take values. */
function walk(words: Arg[], spec: Spec): Walked {
  const out: Walked = { opts: [], operands: [] };
  let end = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const v = w.value;
    if (end || w.unresolved || v === "-" || !v.startsWith("-")) {
      out.operands.push(w);
      continue;
    }
    if (v === "--") {
      end = true;
      continue;
    }
    if (v.startsWith("--")) {
      const eq = v.indexOf("=");
      if (eq >= 0) out.opts.push({ name: v.slice(0, eq), value: { ...w, value: v.slice(eq + 1) } });
      else if (spec.long.includes(v)) out.opts.push({ name: v, value: words[++i] });
      else out.opts.push({ name: v });
      continue;
    }
    for (let k = 1; k < v.length; k++) {
      const ch = v[k]!;
      if (!spec.short.includes(ch)) {
        out.opts.push({ name: `-${ch}` });
        continue;
      }
      const rest = v.slice(k + 1);
      out.opts.push({ name: `-${ch}`, value: rest ? { ...w, value: rest } : words[++i] });
      break;
    }
  }
  return out;
}

const has = (w: Walked, ...names: string[]) => w.opts.some((o) => names.includes(o.name));
const values = (w: Walked, ...names: string[]) => w.opts.filter((o) => names.includes(o.name) && o.value).map((o) => o.value!);

const NO_VALUES: Spec = { short: "", long: [] };
/** Every operand is a file whose contents are printed. */
const READERS: Record<string, Spec> = {
  cat: NO_VALUES,
  head: { short: "nc", long: ["--lines", "--bytes"] },
  tail: { short: "ncs", long: ["--lines", "--bytes", "--pid", "--sleep-interval", "--max-unchanged-stats"] },
  less: { short: "bhjkoOpPtTxyz", long: [] },
  more: { short: "n", long: ["--lines"] },
  bat: { short: "lrmHp", long: ["--language", "--line-range", "--map-syntax", "--highlight-line", "--file-name", "--style", "--theme", "--tabs", "--wrap", "--terminal-width", "--color", "--decorations", "--paging", "--pager"] },
  base64: { short: "w", long: ["--wrap"] },
  od: { short: "AjNSt", long: ["--address-radix", "--skip-bytes", "--read-bytes", "--strings", "--format", "--width"] },
  strings: { short: "nteT", long: ["--bytes", "--radix", "--encoding", "--target"] },
};
READERS.batcat = READERS.bat!;

const GREP: Spec = { short: "efmABCdD", long: ["--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context", "--include", "--exclude", "--exclude-dir", "--exclude-from", "--label", "--devices", "--directories", "--binary-files"] };
const RG: Spec = { short: "efmABCgtTjMrE", long: ["--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context", "--glob", "--iglob", "--type", "--type-not", "--threads", "--max-columns", "--replace", "--encoding", "--ignore-file", "--pre", "--sort", "--sortr", "--max-depth", "--max-filesize", "--colors", "--path-separator"] };
const SED: Spec = { short: "efl", long: ["--expression", "--file", "--line-length"] };
const AWK: Spec = { short: "fvF", long: ["--file", "--assign", "--field-separator"] };
const CP: Spec = { short: "tS", long: ["--target-directory", "--suffix"] };
const SCP: Spec = { short: "cDFiJloPSX", long: [] };
const RSYNC: Spec = { short: "efTBM", long: ["--rsh", "--filter", "--exclude", "--include", "--exclude-from", "--include-from", "--files-from", "--temp-dir", "--partial-dir", "--backup-dir", "--compare-dest", "--copy-dest", "--link-dest", "--chmod", "--suffix", "--log-file", "--out-format", "--rsync-path", "--timeout", "--password-file"] };

/** Files a pattern tool reads: with -e/-f every operand is a file; otherwise the first is the pattern/script. */
function afterScript(w: Walked, scriptOpts: string[], fileOpts: string[]): Arg[] {
  const files = values(w, ...fileOpts);
  return has(w, ...scriptOpts, ...fileOpts) ? [...files, ...w.operands] : w.operands.slice(1);
}

/** The words of `c` naming files whose contents it reads, and the verb for the reason. */
function readTargets(c: SimpleCommand): { verb: string; args: Arg[] } | null {
  if (c.program === null || c.programUnresolved) return null;
  const prog = basename(c.program);
  const words = c.argWords;
  const reader = READERS[prog];
  if (reader) return { verb: `${prog} reads`, args: walk(words, reader).operands };
  if (prog === "xxd") return { verb: "xxd reads", args: walk(words, { short: "lscgo", long: [] }).operands.slice(0, 1) };
  if (prog === "grep" || prog === "egrep" || prog === "fgrep") return { verb: `${prog} reads`, args: afterScript(walk(words, GREP), ["-e", "--regexp"], ["-f", "--file"]) };
  if (prog === "rg") return { verb: "rg reads", args: afterScript(walk(words, RG), ["-e", "--regexp"], ["-f", "--file"]) };
  if (prog === "sed") return { verb: "sed reads", args: afterScript(walk(words, SED), ["-e", "--expression"], ["-f", "--file"]) };
  if (prog === "awk" || prog === "gawk" || prog === "mawk") {
    // var=value operands are assignments, not files.
    const files = afterScript(walk(words, AWK), [], ["-f", "--file"]).filter((a) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a.value));
    return { verb: `${prog} reads`, args: files };
  }
  if (prog === "cp" || prog === "scp" || prog === "rsync") {
    const w = walk(words, prog === "cp" ? CP : prog === "scp" ? SCP : RSYNC);
    const sources = prog === "cp" && has(w, "-t", "--target-directory") ? w.operands : w.operands.slice(0, -1);
    return { verb: `${prog} copies`, args: sources };
  }
  return null;
}

/** git log/show/diff options that show file names or counts only, not contents. */
const NAMES_ONLY = ["--stat", "--name-only", "--name-status", "--numstat", "--shortstat", "--dirstat", "--summary", "--raw", "-s", "--no-patch", "--quiet", "--compact-summary"];
const isPatchOpt = (o: string) => o === "-p" || o === "-u" || o === "--patch" || o.startsWith("--unified") || /^-U\d*$/.test(o) || o.startsWith("--patch-with");

/** Paths whose contents a git show/log/diff call prints, and the verb. */
function gitTargets(c: SimpleCommand, ctx: RuleContext): { verb: string; args: Arg[]; dir: string | null } | null {
  const g = gitCall(c, ctx);
  if (!g || !["show", "log", "diff"].includes(g.sub)) return null;
  const split = g.args.findIndex((a) => !a.unresolved && a.value === "--");
  const before = split < 0 ? g.args : g.args.slice(0, split);
  const paths = split < 0 ? [] : g.args.slice(split + 1);
  const opts = before.filter((a) => !a.unresolved && a.value.startsWith("-")).map((a) => a.value);
  const patch = opts.some(isPatchOpt);
  const namesOnly = opts.some((o) => NAMES_ONLY.some((n) => o === n || o.startsWith(n + "=")));
  const content = (g.sub === "log" ? patch : true) && (patch || !namesOnly);
  if (!content) return null;
  const args = [...paths];
  if (g.sub === "show") {
    // rev:path (HEAD:.env, main:config/x.json) and :n:path / :path (the index).
    for (const a of before) {
      if (a.unresolved || a.value.startsWith("-")) continue;
      const m = /^(?::[0-3]:|[^:]*:)(.+)$/.exec(a.value);
      if (m) args.push({ ...a, value: m[1]! });
    }
  }
  const verb = g.sub === "log" ? "git log -p prints" : `git ${g.sub} prints`;
  return { verb, args, dir: g.dir };
}

/** How to show a path in the reason: ~ for home, otherwise as written. */
function shown(value: string, ctx: RuleContext): string {
  if (value.startsWith("/") && value.startsWith(ctx.home + sep)) return "~" + value.slice(ctx.home.length);
  return value;
}

function tip(why: string): string {
  return why === "an .env file"
    ? "Read .env.example instead, or ask the user for the specific value you need."
    : "Ask the user for the specific value you need instead of reading the file.";
}

export const shellRead: Rule = {
  id: ID,
  category: "secret-access",
  triggers: ["cat", "head", "tail", "less", "more", "bat", "batcat", "grep", "egrep", "fgrep", "rg", "sed", "awk", "gawk", "mawk", "base64", "xxd", "od", "strings", "cp", "scp", "rsync", "git", "<"],
  check(ctx) {
    const out: Finding[] = [];
    const seen = new Set<string>();
    const add = (verb: string, arg: Arg, cwd: string | null, fromHistory: boolean) => {
      if (arg.unresolved || arg.value === "" || arg.value === "-") return;
      const why = secretLooking(arg.value, cwd, ctx.home);
      if (!why) return;
      const abs = resolvePath(arg.value, cwd ?? "/", ctx.home);
      if (seen.has(abs)) return;
      seen.add(abs);
      const where = fromHistory ? " from git history" : "";
      out.push({ ruleId: ID, category: "secret-access", severity: "medium", reason: `${verb} ${why}${where}, which may hold secrets: ${shown(arg.value, ctx)}.`, suggestion: tip(why) });
    };
    for (const c of ctx.commands) {
      const r = readTargets(c);
      if (r) for (const a of r.args) add(r.verb, a, c.cwd, false);
      const g = gitTargets(c, ctx);
      if (g) for (const a of g.args) add(g.verb, a, g.dir, true);
      for (const d of c.redirects) {
        if (d.kind !== "file" || d.op !== "<" || d.unresolved || d.target === null) continue;
        add("Input redirection (<) reads", { value: d.target, raw: d.target, unresolved: false }, c.cwd, false);
      }
    }
    return out;
  },
};
