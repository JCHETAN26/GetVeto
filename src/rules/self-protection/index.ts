// self-protection rules: the agent can't switch Veto off for itself.
import type { Rule } from "../types.js";
import { selfOverride } from "./override.js";

export const rules: Rule[] = [selfOverride];
