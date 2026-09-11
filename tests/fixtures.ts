import { Ledger } from "../src/ledger.js";
import { InMemorySink, LedgerSink, SinkAppendInput } from "../src/sink.js";

export function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

export async function seedLedger(n = 3): Promise<Ledger> {
  const ledger = new Ledger();
  for (let i = 0; i < n; i++) {
    await ledger.recordAction({
      kind: i % 2 === 0 ? "proposal" : "execution",
      actor: `agent-${i}`,
      action: "tool.call",
      subject: `subject-${i}`,
      outcome: i % 2 === 0 ? undefined : "success",
      attributes: { durationMs: i * 10 },
      occurredAt: nowIso(-1000),
    });
  }
  return ledger;
}

export class RecordingSink implements LedgerSink {
  calls: SinkAppendInput[] = [];
  append(input: SinkAppendInput): void {
    this.calls.push(input);
  }
}
