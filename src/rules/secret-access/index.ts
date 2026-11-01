// Secret access via the shell (e.g. a command that reads credential stores).
// TODO(founder): these rules are founder-authored, together with their test cases. This module
// is an intentional empty placeholder so the category is registered; it returns no findings.
// (Secret-looking file paths on Read/Write/Edit are covered in file-tools/secret-path.ts.)
import type { Rule } from "../types.js";

export const rules: Rule[] = [];
