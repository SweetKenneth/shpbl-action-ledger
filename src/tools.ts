/** Tool surface shared by the MCP server and any embedding skill. Four tools, SPEC §3. */
import { Ledger, RecordActionInput } from "./ledger.js";
import { verifyLedger } from "./verify.js";
import { LedgerError, Json } from "./canonical.js";

export const TOOLS = [
  {
    name: "record_action",
    description: "Record one agent action (proposal, execution, redaction or annotation) as the next entry in the hash-linked ledger.",
    inputSchema: {
      type: "object",
      required: ["kind", "actor", "action", "occurredAt"],
      properties: {
        kind: { type: "string", enum: ["proposal", "execution", "redaction", "annotation"] },
        actor: { type: "string" },
        action: { type: "string" },
        subject: { type: "string" },
        outcome: { type: "string", enum: ["pending", "success", "failure", "refused"] },
        attributes: { type: "object" },
        links: { type: "array", items: { type: "string" } },
        occurredAt: { type: "string" },
      },
    },
  },
  {
    name: "export_ledger",
    description: "Export a self-contained, verifiable range of the ledger.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "integer" },
        to: { type: "integer" },
        includeRedacted: { type: "boolean" },
      },
    },
  },
  {
    name: "verify_ledger",
    description: "Verify an exported ledger document using only its own bytes. No live store is consulted.",
    inputSchema: {
      type: "object",
      required: ["export"],
      properties: { export: { type: "object" } },
    },
  },
  {
    name: "describe_policy",
    description: "Return the active redaction allowlist, hash algorithm, canonicalization and export format versions, clock-skew bound, size limits and anchoring policy.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

export function callTool(ledger: Ledger, name: string, args: any): Json | Promise<Json> {
  switch (name) {
    case "record_action":
      return ledger.recordAction(args as RecordActionInput).then((e) => e as unknown as Json);
    case "export_ledger":
      return ledger.exportLedger(args ?? {});
    case "verify_ledger":
      return verifyLedger(args?.export) as unknown as Json;
    case "describe_policy":
      return ledger.describePolicy();
    default:
      throw new LedgerError("E_INPUT", "unknown tool", "name");
  }
}
