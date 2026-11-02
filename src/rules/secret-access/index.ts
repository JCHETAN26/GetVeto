// secret-access rules (Bash): shell commands that read secret-looking files or dump the
// environment. Secret-looking paths on Read/Write/Edit are file-tools/secret-path; both use
// the same list (../secret-paths.ts). One rule per file.
import type { Rule } from "../types.js";
import { shellRead } from "./shell-read.js";

export const rules: Rule[] = [shellRead];
