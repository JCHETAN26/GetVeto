// Exfiltration of secrets over the network (high):
// Catches secrets or environment dumps flowing into a network client:
//   - A secret read (cat, head, git show, < .env) or env dump (printenv, env) piped into
//     a network sender (curl, wget, httpie, nc, socat, telnet).
//   - A network sender reading a secret directly via input redirection (< .env).
//   - curl/wget uploading a secret file directly (-d @.env, --post-file .env).
//   - scp / rsync copying a secret file to a remote destination.
//   - A command substitution that reads a secret inside a network sender.
// High: in guard mode this is denied before the call runs.
import { basename } from "node:path";
import { optValues, RSYNC, SCP, walkOptions } from "../args.js";
import { isEnvDump } from "../secret-access/env-dump.js";
import { gitTargets, readTargets, shown } from "../secret-access/shell-read.js";
import { secretLooking } from "../secret-paths.js";
import type { SimpleCommand } from "../../shell/parse.js";
import type { Finding, Rule, RuleContext } from "../types.js";
import {
  CURL,
  DATA_OPTS,
  hasInput,
  httpFinding,
  isListening,
  listenerHost,
  remoteHost,
  uploadsFile,
  urlHost,
  WGET,
} from "./network-send.js";

const ID = "exfiltration/secret-to-network";
const TIP = "Do not send secrets or environment dumps to external hosts.";

interface SecretInfo {
  desc: string;
  target?: string;
}

/** Does `c` produce secret data (reads a secret file, from git history, redirect, or dumps env)? */
function secretSource(c: SimpleCommand, ctx: RuleContext): SecretInfo | null {
  const dump = isEnvDump(c);
  if (dump) return { desc: "environment variables" };

  const r = readTargets(c);
  if (r) {
    for (const a of r.args) {
      if (a.unresolved || a.value === "" || a.value === "-") continue;
      const why = secretLooking(a.value, c.cwd, ctx.home);
      if (why) return { desc: why, target: a.value };
    }
  }

  const g = gitTargets(c, ctx);
  if (g) {
    for (const a of g.args) {
      if (a.unresolved || a.value === "" || a.value === "-") continue;
      const why = secretLooking(a.value, g.dir, ctx.home);
      if (why) return { desc: `${why} from git history`, target: a.value };
    }
  }

  for (const d of c.redirects) {
    if (d.kind === "file" && d.op === "<" && !d.unresolved && d.target !== null) {
      const why = secretLooking(d.target, c.cwd, ctx.home);
      if (why) return { desc: why, target: d.target };
    }
  }

  return null;
}

/** Information about a network sender command. */
interface NetSenderInfo {
  command: SimpleCommand;
  prog: string;
  host: string | null;
}

function asNetSender(c: SimpleCommand): NetSenderInfo | null {
  if (c.program === null || c.programUnresolved) return null;
  const prog = basename(c.program);
  if (prog === "curl" || prog === "wget" || prog === "http" || prog === "https" || prog === "httpie") {
    const r = httpFinding(prog, c);
    if (r) return { command: c, prog, host: r.host };
  } else if (prog === "nc" || prog === "ncat" || prog === "socat" || prog === "telnet") {
    if (hasInput(c) && !isListening(prog, c)) {
      return { command: c, prog, host: listenerHost(prog, c.argWords) };
    }
  } else if (prog === "scp" || prog === "rsync" || prog === "sftp") {
    const w = walkOptions(c.argWords, prog === "rsync" ? RSYNC : SCP);
    const ops = w.operands.filter((o) => !o.unresolved);
    if (prog === "sftp") {
      const bare = (v: string) => (v.includes(":") || v.includes("/") ? null : v.includes("@") ? v.slice(v.lastIndexOf("@") + 1) : v);
      const host = ops.map((o) => remoteHost(o.value) ?? bare(o.value)).find((h) => h) ?? null;
      if (host) return { command: c, prog, host };
    } else {
      const dest = ops[ops.length - 1];
      const host = dest ? remoteHost(dest.value) : null;
      if (host) return { command: c, prog, host };
    }
  }
  return null;
}

/** Extract path after @ in a curl argument like -d @.env or -F file=@.env */
function extractAtFile(val: string): string | null {
  const idx = val.indexOf("@");
  if (idx < 0) return null;
  const path = val.slice(idx + 1).trim();
  return path === "" || path === "-" ? null : path;
}

export const secretNetwork: Rule = {
  id: ID,
  category: "exfiltration",
  triggers: [
    "curl", "wget", "http", "https", "httpie", "nc", "ncat", "socat", "telnet", "scp", "rsync", "sftp",
    "cat", "head", "tail", "grep", "sed", "awk", "base64", "printenv", "env", "set", "export", "git", "<",
  ],
  check(ctx) {
    const out: Finding[] = [];
    const seen = new Set<string>();

    const flag = (sender: string, secretDesc: string, targetPath: string | undefined, host: string | null) => {
      const dest = host ? `to ${host}` : "to an external host";
      const targetStr = targetPath ? ` (${shown(targetPath, ctx)})` : "";
      const reason = `${sender} sends ${secretDesc}${targetStr} ${dest}, which exfiltrates sensitive data.`;
      if (seen.has(reason)) return;
      seen.add(reason);
      out.push({
        ruleId: ID,
        category: "exfiltration",
        severity: "high",
        reason,
        suggestion: TIP,
      });
    };

    // 1. Pipeline flows: earlier stages producing secrets piped into a network sender
    for (let i = 0; i < ctx.commands.length; i++) {
      const c = ctx.commands[i]!;
      const net = asNetSender(c);
      if (net && c.inPipeline && c.pipeStage > 0) {
        // Look at preceding commands in the same pipeline (earlier stages)
        for (let j = 0; j < i; j++) {
          const prev = ctx.commands[j]!;
          if (prev.inPipeline && prev.pipeStage < c.pipeStage) {
            const sec = secretSource(prev, ctx);
            if (sec) {
              flag(net.prog, sec.desc, sec.target, net.host);
            }
          }
        }
      }
    }

    // 2. Direct input redirection (< .env) on a network sender
    for (const c of ctx.commands) {
      if (c.program === null || c.programUnresolved) continue;
      const prog = basename(c.program);
      const isNet =
        prog === "curl" || prog === "wget" || prog === "http" || prog === "https" ||
        prog === "httpie" || prog === "nc" || prog === "ncat" || prog === "socat" || prog === "telnet";
      if (!isNet) continue;

      for (const r of c.redirects) {
        if (r.kind === "file" && r.op === "<" && !r.unresolved && r.target !== null) {
          const why = secretLooking(r.target, c.cwd, ctx.home);
          if (why) {
            const host =
              (prog === "curl" || prog === "wget" || prog === "http" || prog === "https" || prog === "httpie")
                ? httpFinding(prog, c)?.host ?? null
                : listenerHost(prog, c.argWords);
            flag(prog, why, r.target, host);
          }
        }
      }
    }

    // 3. Direct upload flags (-d @.env, --post-file .env) or scp/rsync secret file sources
    for (const c of ctx.commands) {
      if (c.program === null || c.programUnresolved) continue;
      const prog = basename(c.program);

      if (prog === "curl" || prog === "http" || prog === "https" || prog === "httpie") {
        const w = walkOptions(c.argWords, CURL);
        const host = httpFinding(prog, c)?.host ?? null;
        for (const opt of w.opts) {
          if (opt.value && DATA_OPTS.has(opt.name) && uploadsFile(opt.value.value)) {
            const path = extractAtFile(opt.value.value);
            if (path) {
              const why = secretLooking(path, c.cwd, ctx.home);
              if (why) flag(prog, why, path, host);
            }
          }
        }
      } else if (prog === "wget") {
        const w = walkOptions(c.argWords, WGET);
        const host = httpFinding(prog, c)?.host ?? null;
        for (const opt of w.opts) {
          if (opt.value && (opt.name === "--post-file" || opt.name === "--body-file")) {
            const why = secretLooking(opt.value.value, c.cwd, ctx.home);
            if (why) flag(prog, why, opt.value.value, host);
          }
        }
      } else if (prog === "scp" || prog === "rsync") {
        const w = walkOptions(c.argWords, prog === "rsync" ? RSYNC : SCP);
        const ops = w.operands.filter((o) => !o.unresolved);
        const dest = ops[ops.length - 1];
        const host = dest ? remoteHost(dest.value) : null;
        if (host) {
          const sources = ops.slice(0, -1);
          for (const s of sources) {
            const why = secretLooking(s.value, c.cwd, ctx.home);
            if (why) flag(prog, why, s.value, host);
          }
        }
      }
    }

    // 4. Command substitutions inside network senders: curl -d "$(cat .env)" https://...
    for (const c of ctx.commands) {
      if (!c.inSubstitution) continue;
      const sec = secretSource(c, ctx);
      if (!sec) continue;

      // Find if any outer command is a network sender
      for (const other of ctx.commands) {
        if (other.inSubstitution) continue;
        const net = asNetSender(other);
        if (net) {
          flag(net.prog, sec.desc, sec.target, net.host);
        }
      }
    }

    return out;
  },
};
