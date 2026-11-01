// destructive rules. Each rule lives in its own file next to this one.
import type { Rule } from "../types.js";
import { gitDiscard } from "./git-discard.js";
import { recursiveRm } from "./recursive-rm.js";

export const rules: Rule[] = [recursiveRm, gitDiscard];
