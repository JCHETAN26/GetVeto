// destructive rules. Each rule lives in its own file next to this one.
import type { Rule } from "../types.js";
import { broad } from "./broad.js";
import { deleteOutsideProject } from "./delete-outside-project.js";
import { forcePush } from "./force-push.js";
import { gitDiscard } from "./git-discard.js";
import { recursiveRm } from "./recursive-rm.js";
import { stashDrop } from "./stash-drop.js";

export const rules: Rule[] = [recursiveRm, gitDiscard, forcePush, broad, deleteOutsideProject, stashDrop];
