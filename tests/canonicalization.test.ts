import { describe, test, expect } from "bun:test";
import { canonical, digestOf, sha256, parseStrict, LedgerError } from "../src/canonical.js";

describe("canonical form (SPEC §2)", () => {
  test("vector: empty object", () => {
    expect(canonical({})).toBe("{}");
  });
  test("vector: empty array", () => {
    expect(canonical([])).toBe("[]");
  });
  test("vector: nested object with mixed types", () => {
    const v = { b: 1, a: [true, false, null], c: "x" };
    expect(canonical(v)).toBe('{"a":[true,false,null],"b":1,"c":"x"}');
  });
  test("vector: digest of a fixed literal matches sha256(canonical(v))", () => {
    const v = { a: 1, b: 2 };
    expect(canonical(v)).toBe('{"a":1,"b":2}');
    expect(digestOf(v)).toBe(sha256('{"a":1,"b":2}'));
    expect(digestOf(v)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("P3: canonical bytes invariant to key insertion order", () => {
    const a = canonical({ z: 1, a: 2, m: 3 });
    const b = canonical({ a: 2, m: 3, z: 1 });
    const c = canonical({ m: 3, z: 1, a: 2 });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("P4: canonical bytes equal for NFC/NFD-equal strings", () => {
    const nfc = "\u00e9"; // é precomposed
    const nfd = "e\u0301"; // e + combining acute
    expect(canonical(nfc)).toBe(canonical(nfd));
    expect(digestOf({ k: nfc })).toBe(digestOf({ k: nfd }));
  });

  test("duplicate keys collapse under Set dedupe in canonical() for direct objects (JS semantics)", () => {
    // JS object literals cannot carry duplicate keys; duplicate-key rejection is enforced by parseStrict.
    expect(canonical({ a: 1 })).toBe('{"a":1}');
  });

  test("non-finite numbers are rejected", () => {
    expect(() => canonical(Number.POSITIVE_INFINITY)).toThrow(LedgerError);
    expect(() => canonical(Number.NaN)).toThrow(LedgerError);
  });

  test("arrays retain order", () => {
    expect(canonical([3, 1, 2])).toBe("[3,1,2]");
  });

  test("parseStrict rejects duplicate object keys", () => {
    expect(() => parseStrict('{"a":1,"a":2}')).toThrow(LedgerError);
  });

  test("parseStrict accepts well-formed unique-key JSON", () => {
    expect(parseStrict('{"a":1,"b":[1,2,3]}')).toEqual({ a: 1, b: [1, 2, 3] });
  });

  test("parseStrict rejects trailing content", () => {
    expect(() => parseStrict('{"a":1} garbage')).toThrow(LedgerError);
  });

  test("P10: two independent digest computations of the same entry body agree", () => {
    const body = { sequence: 0, kind: "proposal", actor: "a", action: "b" };
    expect(digestOf(body)).toBe(digestOf(JSON.parse(JSON.stringify(body))));
  });
});
