import { describe, test, expect } from "bun:test";
import { handle } from "../src/mcp-server.js";
import { TOOLS, callTool } from "../src/tools.js";
import { Ledger } from "../src/ledger.js";

function capture(): { calls: any[]; write: (s: string) => boolean } {
  const calls: any[] = [];
  return { calls, write: (s: string) => (calls.push(JSON.parse(s)), true) };
}

describe("MCP JSON-RPC 2.0 stdio surface", () => {
  test("initialize returns server info and tool capability", async () => {
    const cap = capture();
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = cap.write as any;
    await handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    process.stdout.write = orig;
    expect(cap.calls[0].result.serverInfo.name).toBe("shpbl-action-ledger");
    expect(cap.calls[0].result.capabilities.tools).toEqual({});
  });

  test("tools/list exposes exactly the four spec tools", async () => {
    const cap = capture();
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = cap.write as any;
    await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    process.stdout.write = orig;
    const names = cap.calls[0].result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["describe_policy", "export_ledger", "record_action", "verify_ledger"]);
  });

  test("tools/call record_action then export_ledger round-trips through JSON-RPC", async () => {
    const cap = capture();
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = cap.write as any;
    await handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "record_action", arguments: { kind: "proposal", actor: "a", action: "b", occurredAt: new Date(Date.now() - 1000).toISOString() } },
    });
    await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "export_ledger", arguments: {} } });
    process.stdout.write = orig;
    const recorded = JSON.parse(cap.calls[0].result.content[0].text);
    expect(recorded.sequence).toBe(0);
    const exported = JSON.parse(cap.calls[1].result.content[0].text);
    expect(exported.count).toBe(1);
  });

  test("unknown method returns a JSON-RPC method-not-found error", async () => {
    const cap = capture();
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = cap.write as any;
    await handle({ jsonrpc: "2.0", id: 5, method: "bogus" });
    process.stdout.write = orig;
    expect(cap.calls[0].error.code).toBe(-32601);
  });

  test("invalid tool input surfaces as a structured JSON-RPC error, never a raw exception", async () => {
    const cap = capture();
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = cap.write as any;
    await handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "record_action", arguments: { kind: "nonsense" } } });
    process.stdout.write = orig;
    expect(cap.calls[0].error.code).toBe(-32602);
    expect(cap.calls[0].error.data.error).toBe("E_INPUT");
  });

  test("unknown tool name is rejected", () => {
    const ledger = new Ledger();
    expect(() => callTool(ledger, "not_a_tool", {})).toThrow();
  });

  test("every declared tool has a JSON Schema inputSchema", () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
    }
  });
});
