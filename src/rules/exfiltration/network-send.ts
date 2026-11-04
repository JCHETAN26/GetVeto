// A network client that sends local data off the machine (medium):
//   - curl / wget / httpie (http, https) with a request body or file upload, or an explicit
//     POST/PUT/PATCH method. A plain GET is not flagged.
//   - nc / ncat / socat / telnet that reads piped or redirected input (so it has data to send).
//   - scp / rsync / sftp whose destination is a remote host.
// Only the parsed command structure is used: options with their values, operands, the pipeline
// position (pipeStage) and redirects. The finding names the destination host when it can.
import { basename } from "node:path";
import { optValues, RSYNC, SCP, walkOptions, type OptionSpec } from "../args.js";
import type { Arg, SimpleCommand } from "../../shell/parse.js";
import type { Finding, Rule, RuleContext } from "../types.js";

const ID = "exfiltration/network-send";
const TIP = "Show the user what you would send and ask first.";

// curl options that take a value, so the URL operand is read cleanly (never as a header value).
export const CURL: OptionSpec = {
  short: "dFTXHouebcxAKDEw",
  long: [
    "--data", "--data-raw", "--data-ascii", "--data-binary", "--data-urlencode", "--json",
    "--form", "--form-string", "--upload-file", "--request", "--header", "--url", "--output",
    "--user", "--user-agent", "--referer", "--cookie", "--cookie-jar", "--proxy", "--write-out",
    "--connect-timeout", "--max-time", "--retry", "--cacert", "--cert", "--key", "--config",
    "--dump-header", "--resolve", "--oauth2-bearer", "--aws-sigv4", "--cert-type", "--range",
  ],
};
export const WGET: OptionSpec = {
  short: "OoPt",
  long: ["--output-document", "--post-data", "--post-file", "--body-data", "--body-file", "--method", "--header", "--referer", "--user-agent", "--directory-prefix"],
};

export const DATA_OPTS = new Set(["-d", "-F", "-T", "--data", "--data-raw", "--data-ascii", "--data-binary", "--data-urlencode", "--json", "--form", "--form-string", "--upload-file"]);
export const METHODS = new Set(["POST", "PUT", "PATCH"]);
/** A value like @file or field=@file uploads a local file. */
export const uploadsFile = (v: string) => /(^|=)@/.test(v);

/** Host of a URL (with scheme) or a bare host[:port][/path] (httpie), or null. */
export function urlHost(s: string): string | null {
  let rest: string;
  const scheme = s.indexOf("://");
  if (scheme >= 0) rest = s.slice(scheme + 3);
  else if (s.includes("=")) return null; // a data field like x=1
  else rest = s;
  let host = rest.split(/[/?#]/, 1)[0] ?? "";
  if (host.includes("@")) host = host.slice(host.lastIndexOf("@") + 1);
  host = host.replace(/:\d+$/, "");
  if (host === "") return null;
  if (scheme < 0 && !(host.includes(".") || host === "localhost" || /^\d+(\.\d+){3}$/.test(host))) return null;
  return host;
}

/** For `[user@]host:path` (scp/rsync/sftp remote spec), the host; null for a local path or URL. */
export function remoteHost(value: string): string | null {
  if (value.includes("://")) return null;
  const colon = value.indexOf(":");
  if (colon <= 0) return null;
  const left = value.slice(0, colon);
  if (left.includes("/")) return null; // a local path that happens to contain a colon
  return left.includes("@") ? left.slice(left.lastIndexOf("@") + 1) : left;
}

/** Host nc/ncat/telnet/socat connects to, or null. */
export function listenerHost(prog: string, operands: Arg[]): string | null {
  const words = operands.filter((o) => !o.unresolved).map((o) => o.value);
  if (prog === "socat") {
    for (const w of words) {
      const parts = w.split(":");
      if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1]!)) return parts[parts.length - 2] || null;
    }
    return null;
  }
  const host = words.find((w) => !w.startsWith("-") && !/^\d+$/.test(w));
  return host ?? null;
}

/** nc/ncat/telnet/socat: is it listening (no outbound data) rather than connecting? */
export const isListening = (prog: string, c: SimpleCommand) =>
  prog !== "socat" && c.argWords.some((a) => !a.unresolved && (a.value === "-l" || a.value === "-lk" || a.value === "--listen" || (a.value.startsWith("-") && !a.value.startsWith("--") && a.value.includes("l"))));

/** Does this command read input from a pipe or a file redirect (so it has something to send)? */
export const hasInput = (c: SimpleCommand) => c.pipeStage > 0 || c.redirects.some((r) => r.kind === "file" && r.op === "<");

export function httpFinding(prog: string, c: SimpleCommand): { host: string | null } | null {
  const spec = prog === "wget" ? WGET : CURL;
  const w = walkOptions(c.argWords, spec);
  const optNames = w.opts.map((o) => o.name);
  const method = [...optValues(w, "-X", "--request", "--method")].map((v) => v.value.toUpperCase());
  const allValues = w.opts.flatMap((o) => (o.value ? [o.value.value] : []));
  const sending =
    optNames.some((n) => DATA_OPTS.has(n) || n === "--post-data" || n === "--post-file" || n === "--body-data" || n === "--body-file") ||
    method.some((m) => METHODS.has(m)) ||
    allValues.some(uploadsFile) ||
    w.operands.some((o) => !o.unresolved && uploadsFile(o.value)) ||
    // httpie: a bare POST/PUT/PATCH method word.
    ((prog === "http" || prog === "https" || prog === "httpie") && w.operands.some((o) => !o.unresolved && METHODS.has(o.value.toUpperCase())));
  if (!sending) return null;
  const urlValues = [...optValues(w, "--url").map((v) => v.value), ...w.operands.filter((o) => !o.unresolved).map((o) => o.value)];
  let host: string | null = null;
  for (const v of urlValues) {
    host = urlHost(v);
    if (host) break;
  }
  return { host };
}

export const networkSend: Rule = {
  id: ID,
  category: "exfiltration",
  triggers: ["curl", "wget", "http", "https", "httpie", "nc", "ncat", "socat", "telnet", "scp", "rsync", "sftp"],
  check(ctx) {
    const out: Finding[] = [];
    const flag = (host: string | null, how: string) =>
      out.push({
        ruleId: ID,
        category: "exfiltration",
        severity: "medium",
        reason: `${how} ${host ? `to ${host}` : "to a remote host"}, which could send local data off the machine.`,
        suggestion: TIP,
      });
    for (const c of ctx.commands) {
      if (c.program === null || c.programUnresolved) continue;
      const prog = basename(c.program);
      if (prog === "curl" || prog === "wget" || prog === "http" || prog === "https" || prog === "httpie") {
        const r = httpFinding(prog, c);
        if (r) flag(r.host, `${prog} sends a request body`);
      } else if (prog === "nc" || prog === "ncat" || prog === "socat" || prog === "telnet") {
        if (hasInput(c) && !isListening(prog, c)) flag(listenerHost(prog, c.argWords), `${prog} sends piped input`);
      } else if (prog === "scp" || prog === "rsync" || prog === "sftp") {
        const w = walkOptions(c.argWords, prog === "rsync" ? RSYNC : SCP);
        const ops = w.operands.filter((o) => !o.unresolved);
        if (prog === "sftp") {
          const bare = (v: string) => (v.includes(":") || v.includes("/") ? null : v.includes("@") ? v.slice(v.lastIndexOf("@") + 1) : v);
          const host = ops.map((o) => remoteHost(o.value) ?? bare(o.value)).find((h) => h);
          if (host) flag(host, "sftp opens a session");
        } else {
          const dest = ops[ops.length - 1];
          const host = dest ? remoteHost(dest.value) : null;
          if (host) flag(host, `${prog} uploads`);
        }
      }
    }
    return out;
  },
};
