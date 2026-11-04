// Exfiltration (data leaving the machine). One rule per file.
// secret-to-network: secrets or environment dumps flowing into a network client (high).
// network-send: a network client sending local data off the machine (medium).
import type { Rule } from "../types.js";
import { networkSend } from "./network-send.js";
import { secretNetwork } from "./secret-network.js";

export const rules: Rule[] = [secretNetwork, networkSend];
