// file-tools rules (Read / Write / Edit / MultiEdit / NotebookEdit). One rule per file.
import type { Rule } from "../types.js";
import { outsideProject } from "./outside-project.js";
import { secretPath } from "./secret-path.js";

export const rules: Rule[] = [outsideProject, secretPath];
