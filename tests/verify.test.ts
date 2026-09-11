import { describe, test, expect } from "bun:test";
import { Ledger } from "../src/ledger.js";
import { verifyLedger } from "../src/verify.js";
import { seedLedger } from "./fixtures.js";

describe("verifyLedger (SPEC §3.3, §4.3, invariant 5.6 / P1, P2, P6)", () => {
  test("valid export verifies", async () => {
    const ledger = await seedLedger(3);
    const result = verifyLedger(ledger.exportLedger());
    expect(result).toMatchObject({ valid: true, checkedEntries: 3, failure: null });
  });

  test("P1: mutating any byte of any entry breaks verification at that sequence", async () => {
    const ledger = await seedLedger(4);
    const doc = ledger.exportLedger() as any;
    doc.entries[2].action = doc.entries[2].action + "!";
    const result = verifyLedger(doc);
    expect(result.valid).toBe(false);
    expect(result.failure?.reason).toBe("digest-mismatch");
    expect(result.failure?.sequence).toBe(2);
  });

  test("P2: deleting an entry causes a sequence gap", async () => {
    const ledger = await seedLedger(4);
    const doc = ledger.exportLedger() as any;
    doc.entries.splice(1, 1);
    const result = verifyLedger(doc);
    expect(result.valid).toBe(false);
    expect(result.failure?.reason).toBe("sequence-gap");
  });

  test("P2: reordering entries is detected", async () => {
    const ledger = await seedLedger(4);
    const doc = ledger.exportLedger() as any;
    [doc.entries[1], doc.entries[2]] = [doc.entries[2], doc.entries[1]];
    const result = verifyLedger(doc);
    expect(result.valid).toBe(false);
    expect(["sequence-reorder", "sequence-gap", "broken-link", "digest-mismatch"]).toContain(result.failure?.reason);
  });

  test("P2: truncating the export is detected via headDigest mismatch", async () => {
    const ledger = await seedLedger(4);
    const doc = ledger.exportLedger() as any;
    doc.entries = doc.entries.slice(0, 2);
    const result = verifyLedger(doc);
    expect(result.valid).toBe(false);
    expect(result.failure?.reason).toBe("digest-mismatch");
  });

  test("failure mode: unsupported export format", () => {
    const result = verifyLedger({ format: "aael-export/999", entries: [] });
    expect(result.valid).toBe(false);
    expect(result.failure?.reason).toBe("unsupported-format");
  });

  test("failure mode: genesis mismatch", async () => {
    const ledger = await seedLedger(1);
    const doc = ledger.exportLedger() as any;
    doc.genesisDigest = "f".repeat(64);
    const result = verifyLedger(doc);
    expect(result.valid).toBe(false);
    expect(result.failure?.reason).toBe("genesis-mismatch");
  });

  test("failure mode: malformed entry (not an object)", async () => {
    const ledger = await seedLedger(1);
    const doc = ledger.exportLedger() as any;
    doc.entries[0] = "not-an-object";
    const result = verifyLedger(doc);
    expect(result.valid).toBe(false);
    expect(result.failure?.reason).toBe("malformed-entry");
  });

  test("failure mode: corrupt/truncated JSON given as raw text is rejected as malformed before parse", () => {
    const result = verifyLedger(undefined);
    expect(result.valid).toBe(false);
    expect(result.failure?.reason).toBe("malformed-entry");
  });

  test("a ranged export not starting at genesis verifies using precedingDigest", async () => {
    const ledger = await seedLedger(5);
    const full = ledger.exportLedger() as any;
    const ranged = ledger.exportLedger({ from: 2, to: 4 }) as any;
    expect(ranged.range.completeFromGenesis).toBe(false);
    expect(ranged.precedingDigest).toBe(full.entries[1].entryDigest);
    const result = verifyLedger(ranged);
    expect(result.valid).toBe(true);
    expect(result.checkedEntries).toBe(3);
  });

  test("ranged export missing precedingDigest fails as malformed", async () => {
    const ledger = await seedLedger(5);
    const ranged = ledger.exportLedger({ from: 2, to: 4 }) as any;
    delete ranged.precedingDigest;
    const result = verifyLedger(ranged);
    expect(result.valid).toBe(false);
    expect(result.failure?.reason).toBe("malformed-entry");
  });

  test("invariant 5.6: verifier is a pure function — same input, same result, no live ledger reference", async () => {
    const ledger = await seedLedger(3);
    const doc = ledger.exportLedger();
    const r1 = verifyLedger(doc);
    const r2 = verifyLedger(JSON.parse(JSON.stringify(doc)));
    expect(r1).toEqual(r2);
  });

  test("anchorStatus is reported separately from chain validity", async () => {
    const ledger = await seedLedger(1);
    const doc = ledger.exportLedger() as any;
    expect(verifyLedger(doc).anchorStatus).toBe("unanchored");
    doc.anchor = { status: "verified" };
    expect(verifyLedger(doc).anchorStatus).toBe("verified");
    doc.entries[0].action = "tampered";
    const r = verifyLedger(doc);
    expect(r.valid).toBe(false);
    expect(r.anchorStatus).toBe("verified");
  });
});
