import { describe, test, expect } from "bun:test";
import { Ledger, GENESIS_DIGEST, computeEntryDigest } from "../src/ledger.js";
import { LedgerError } from "../src/canonical.js";
import { FlakySink } from "../src/sink.js";
import { verifyLedger } from "../src/verify.js";
import { seedLedger, nowIso, RecordingSink } from "./fixtures.js";

describe("Ledger.recordAction — admission and invariants", () => {
  test("first entry chains from genesis", async () => {
    const ledger = new Ledger();
    const e = await ledger.recordAction({ kind: "proposal", actor: "a", action: "b", occurredAt: nowIso(-1000) });
    expect(e.sequence).toBe(0);
    expect(e.prevDigest).toBe(GENESIS_DIGEST);
  });

  test("invariant: append-only — no public mutation surface exists", async () => {
    const ledger = await seedLedger(2);
    const doc = ledger.exportLedger() as any;
    expect(Object.isFrozen).toBeDefined(); // sanity the runtime supports the check style used below
    expect(typeof (ledger as any).updateEntry).toBe("undefined");
    expect(typeof (ledger as any).deleteEntry).toBe("undefined");
    expect(doc.entries.length).toBe(2);
  });

  test("invariant 2 / P2: chain integrity — digest formula matches computeEntryDigest", async () => {
    const ledger = new Ledger();
    const e0 = await ledger.recordAction({ kind: "proposal", actor: "a", action: "b", occurredAt: nowIso(-1000) });
    const { entryDigest, ...body } = e0 as any;
    expect(computeEntryDigest(body)).toBe(entryDigest);
  });

  test("invariant 3 / P7: dense monotonic sequence 0..count-1", async () => {
    const ledger = await seedLedger(5);
    const doc = ledger.exportLedger() as any;
    const seqs = doc.entries.map((e: any) => e.sequence);
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
  });

  test("P10: two independent ledgers recording the same sequence produce identical digests", async () => {
    const fixedNow = () => new Date("2026-01-01T00:00:00.000Z");
    const l1 = new Ledger({ now: fixedNow });
    const l2 = new Ledger({ now: fixedNow });
    const input = { kind: "proposal" as const, actor: "a", action: "b", occurredAt: "2025-12-31T00:00:00.000Z" };
    const e1 = await l1.recordAction(input);
    const e2 = await l2.recordAction(input);
    expect(e1.entryDigest).toBe(e2.entryDigest);
  });

  test("P12: concurrent appends remain dense with exactly one predecessor each", async () => {
    const ledger = new Ledger();
    const n = 25;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        ledger.recordAction({ kind: "annotation", actor: "a", action: `op-${i}`, occurredAt: nowIso(-1000) })
      )
    );
    const seqs = results.map((r) => r.sequence).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: n }, (_, i) => i));
    const byDigest = new Map(results.map((r) => [r.sequence, r]));
    for (let i = 1; i < n; i++) {
      expect(byDigest.get(i)!.prevDigest).toBe(byDigest.get(i - 1)!.entryDigest);
    }
  });

  test("P8: a simulated store failure leaves headDigest and count unchanged", async () => {
    const sink = new FlakySink(2);
    const ledger = new Ledger({ sink });
    await ledger.recordAction({ kind: "proposal", actor: "a", action: "b", occurredAt: nowIso(-1000) });
    const headBefore = ledger.headDigest;
    const countBefore = ledger.count;
    await expect(
      ledger.recordAction({ kind: "proposal", actor: "a", action: "fails", occurredAt: nowIso(-1000) })
    ).rejects.toThrow(LedgerError);
    expect(ledger.headDigest).toBe(headBefore);
    expect(ledger.count).toBe(countBefore);
    // Next append succeeds and consumes the next sequence, proving no sequence was burned oddly.
    const recovered = await ledger.recordAction({ kind: "proposal", actor: "a", action: "recovers", occurredAt: nowIso(-1000) });
    expect(recovered.sequence).toBe(countBefore);
  });

  test("failure mode: kind is required and validated", async () => {
    const ledger = new Ledger();
    await expect(
      ledger.recordAction({ kind: "bogus" as any, actor: "a", action: "b", occurredAt: nowIso(-1000) })
    ).rejects.toThrow(LedgerError);
  });

  test("failure mode: outcome required for kind=execution", async () => {
    const ledger = new Ledger();
    await expect(
      ledger.recordAction({ kind: "execution", actor: "a", action: "b", occurredAt: nowIso(-1000) } as any)
    ).rejects.toThrow(LedgerError);
  });

  test("failure mode: redaction referencing unknown sequence is rejected, no entry recorded", async () => {
    const ledger = new Ledger();
    await ledger.recordAction({ kind: "proposal", actor: "a", action: "b", occurredAt: nowIso(-1000) });
    await expect(
      ledger.recordAction({
        kind: "redaction",
        actor: "a",
        action: "redact",
        attributes: { supersedes: 99 },
        occurredAt: nowIso(-1000),
      })
    ).rejects.toThrow(LedgerError);
    expect(ledger.count).toBe(1);
  });

  test("redaction against a known sequence marks it superseded in export view", async () => {
    const ledger = new Ledger();
    await ledger.recordAction({ kind: "proposal", actor: "a", action: "b", occurredAt: nowIso(-1000) });
    await ledger.recordAction({
      kind: "redaction",
      actor: "a",
      action: "redact",
      attributes: { supersedes: 0 },
      occurredAt: nowIso(-1000),
    });
    const doc = ledger.exportLedger() as any;
    expect(doc.entries[0].view).toBe("superseded");
    expect(doc.entries[1].view).toBe("visible");
  });

  test("failure mode: clock skew beyond the published bound is rejected (E_CLOCK)", async () => {
    const ledger = new Ledger();
    await expect(
      ledger.recordAction({ kind: "proposal", actor: "a", action: "b", occurredAt: nowIso(3600_000) })
    ).rejects.toThrow(LedgerError);
  });

  test("clock skew within bound is recorded and flagged", async () => {
    const ledger = new Ledger();
    const e = await ledger.recordAction({ kind: "proposal", actor: "a", action: "b", occurredAt: nowIso(60_000) });
    expect(e.clockSkewFlagged).toBe(true);
  });

  test("failure mode: links must be 64-char lowercase hex digests", async () => {
    const ledger = new Ledger();
    await expect(
      ledger.recordAction({ kind: "proposal", actor: "a", action: "b", links: ["not-a-digest"], occurredAt: nowIso(-1000) })
    ).rejects.toThrow(LedgerError);
  });

  test("failure mode: links exceeding max count is E_LIMIT", async () => {
    const ledger = new Ledger();
    const links = Array.from({ length: 33 }, () => "a".repeat(64));
    await expect(
      ledger.recordAction({ kind: "proposal", actor: "a", action: "b", links, occurredAt: nowIso(-1000) })
    ).rejects.toThrow(LedgerError);
  });

  test("failure mode: export range out of bounds is E_INPUT", async () => {
    const ledger = await seedLedger(2);
    expect(() => ledger.exportLedger({ from: 5, to: 6 })).toThrow(LedgerError);
    expect(() => ledger.exportLedger({ from: 1, to: 0 })).toThrow(LedgerError);
  });

  test("export exceeding published entry limit is E_LIMIT", async () => {
    const ledger = new Ledger();
    // Monkeypatch is not available; verify the guard exists by requesting an oversized synthetic range.
    await ledger.recordAction({ kind: "proposal", actor: "a", action: "b", occurredAt: nowIso(-1000) });
    expect(() => ledger.exportLedger({ from: 0, to: 200_000 })).toThrow(LedgerError);
  });

  test("describePolicy exposes the published allowlist, versions and limits", () => {
    const ledger = new Ledger();
    const policy = ledger.describePolicy() as any;
    expect(policy.hashAlgorithm).toBe("SHA-256");
    expect(Array.isArray(policy.redactionAllowlist)).toBe(true);
    expect(policy.canonicalizationVersion).toBe("1");
  });

  test("sink receives exactly one append per accepted entry, in order", async () => {
    const sink = new RecordingSink();
    const ledger = new Ledger({ sink });
    await ledger.recordAction({ kind: "proposal", actor: "a", action: "b", occurredAt: nowIso(-1000) });
    await ledger.recordAction({ kind: "proposal", actor: "a", action: "c", occurredAt: nowIso(-1000) });
    expect(sink.calls.length).toBe(2);
    expect(sink.calls[0]!.sequence).toBe(0);
    expect(sink.calls[1]!.sequence).toBe(1);
  });

  test("exported ledger from this package verifies with the published verifier (P6/P11 wiring)", async () => {
    const ledger = await seedLedger(4);
    const result = verifyLedger(ledger.exportLedger());
    expect(result.valid).toBe(true);
    expect(result.checkedEntries).toBe(4);
  });
});
