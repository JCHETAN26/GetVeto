// Exfiltration (data leaving the machine). One rule per file.
// network-send: a network client sending local data off the machine.
// TODO(founder): secret-to-network (a secret read or env dump flowing into a network client in
// the same command) is founder-authored and not implemented yet; such a flow is currently only
// the medium "ask" from network-send, not a high "deny".
import type { Rule } from "../types.js";
import { networkSend } from "./network-send.js";

export const rules: Rule[] = [networkSend];
