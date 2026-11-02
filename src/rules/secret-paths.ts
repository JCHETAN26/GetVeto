// Which file paths look like they hold secrets. One list, shared by the file-tool rule
// (file-tools/secret-path) and the shell rule (secret-access/shell-read):
//   .env and .env.* (not .env.example / .env.sample / .env.template), *.pem, *.key,
//   id_rsa*, id_ed25519*, anything under ~/.ssh, ~/.aws/credentials, ~/.npmrc, ~/.netrc,
//   *credentials*.json.
import { basename, sep } from "node:path";
import { resolvePath } from "../shell/paths.js";

const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);
const HOME_FILES: Record<string, string> = {
  ".aws/credentials": "the AWS credentials file",
  ".npmrc": "your ~/.npmrc",
  ".netrc": "your ~/.netrc",
};

/**
 * Why `path` looks like a secret (a short noun phrase, e.g. "an .env file"), or null.
 * Relative paths resolve against cwd (or "/" when unknown, which still catches file names).
 */
export function secretLooking(path: string, cwd: string | null, home: string): string | null {
  const abs = resolvePath(path, cwd ?? "/", home);
  const name = basename(abs);
  const ssh = resolvePath("~/.ssh", "/", home);
  if (abs === ssh || abs.startsWith(ssh + sep)) return "a file under ~/.ssh";
  if ((name === ".env" || name.startsWith(".env.")) && !ENV_TEMPLATES.has(name)) return "an .env file";
  if (name.endsWith(".pem") || name.endsWith(".key")) return "a key or certificate file";
  if (name.startsWith("id_rsa") || name.startsWith("id_ed25519")) return "an SSH key file";
  for (const [rel, why] of Object.entries(HOME_FILES)) if (abs === resolvePath(`~/${rel}`, "/", home)) return why;
  if (/credentials/i.test(name) && name.toLowerCase().endsWith(".json")) return "a credentials JSON file";
  return null;
}
