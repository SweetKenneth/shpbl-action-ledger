#!/usr/bin/env node
/**
 * Minimal MCP stdio server: newline-delimited JSON-RPC 2.0, zero dependencies.
 * stdin/stdout only — no socket, no fetch, no ambient file write.
 */
import { Ledger } from "./ledger.js";
import { LedgerError } from "./canonical.js";
import { callTool, TOOLS } from "./tools.js";

const ledger = new Ledger();

function respond(id: unknown, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function fail(id: unknown, code: number, message: string, data?: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } }) + "\n");
}

export async function handle(message: any): Promise<void> {
  const { id, method, params } = message ?? {};
  try {
    switch (method) {
      case "initialize":
        return respond(id, {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "shpbl-action-ledger", version: "0.1.0" },
          capabilities: { tools: {} },
        });
      case "tools/list":
        return respond(id, { tools: TOOLS });
      case "tools/call": {
        const result = await callTool(ledger, params?.name, params?.arguments ?? {});
        return respond(id, { content: [{ type: "text", text: JSON.stringify(result) }], isError: false });
      }
      case "notifications/initialized":
      case "ping":
        return id === undefined ? undefined : respond(id, {});
      default:
        return fail(id, -32601, "method not found");
    }
  } catch (err) {
    if (err instanceof LedgerError) return fail(id, -32602, err.code, err.toJSON());
    return fail(id, -32603, "internal error");
  }
}

if (process.argv[1] && process.argv[1].includes("mcp-server")) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        void handle(JSON.parse(line));
      } catch {
        fail(null, -32700, "parse error");
      }
    }
  });
}
