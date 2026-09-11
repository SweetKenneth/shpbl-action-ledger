// Canonical form + hashing. SHA-256 only, no other digest is produced anywhere (SPEC §2, §5.4).
import { createHash } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type ErrorCode = "E_INPUT" | "E_LIMIT" | "E_STORE" | "E_CLOCK" | "E_CONFLICT" | "E_NOT_FOUND";

/**
 * Errors are structured and value-free (SPEC §7): identifiers, limits and JSON pointers
 * only. `detail` is always a fixed phrase chosen by this package, never interpolated from
 * caller input, which is what makes property P5 (redaction totality) provable.
 */
export class LedgerError extends Error {
  readonly code: ErrorCode;
  readonly pointer: string;
  readonly limit?: string;
  readonly observed?: number;
  constructor(code: ErrorCode, detail: string, pointer = "", extra?: { limit?: string; observed?: number }) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.pointer = pointer;
    this.limit = extra?.limit;
    this.observed = extra?.observed;
    this.name = "LedgerError";
  }
  toJSON(): Json {
    const body: Record<string, Json> = { error: this.code, detail: this.message.slice(this.code.length + 2), pointer: this.pointer };
    if (this.limit !== undefined) body.limit = this.limit;
    if (this.observed !== undefined) body.observed = this.observed;
    return body;
  }
}

function codepointCompare(a: string, b: string): number {
  const ai = Array.from(a);
  const bi = Array.from(b);
  const len = Math.min(ai.length, bi.length);
  for (let i = 0; i < len; i++) {
    const ac = ai[i]!.codePointAt(0)!;
    const bc = bi[i]!.codePointAt(0)!;
    if (ac !== bc) return ac - bc;
  }
  return ai.length - bi.length;
}

/**
 * Deterministic canonical JSON (SPEC §2 canonical form): object keys sorted by Unicode code
 * point, no insignificant whitespace, integers base-10, every string NFC-normalized, arrays
 * keep order. This is canonicalization version "1"; changing this function requires a new
 * version identifier (SPEC §3.4).
 */
export function canonical(value: Json): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new LedgerError("E_INPUT", "non-finite number is not canonicalizable");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).map((k) => k.normalize("NFC"));
    const sorted = [...new Set(keys)].sort(codepointCompare);
    return (
      "{" +
      sorted.map((k) => JSON.stringify(k) + ":" + canonical((value as Record<string, Json>)[k]!)).join(",") +
      "}"
    );
  }
  throw new LedgerError("E_INPUT", "value is not canonicalizable");
}

export const CANONICALIZATION_VERSION = "1";
export const HASH_ALGORITHM = "SHA-256";

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function digestOf(value: Json): string {
  return sha256(canonical(value));
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Strict JSON.parse that rejects duplicate object keys (SPEC §3.1 admission rule). Ordinary
 * `JSON.parse` silently keeps the last of a duplicate key; this preserves the ambiguity as a
 * rejection instead.
 */
export function parseStrict(text: string): Json {
  const p = new StrictJsonParser(text);
  const value = p.parseValue();
  p.skipWs();
  if (p.pos !== text.length) throw new LedgerError("E_INPUT", "trailing content after JSON value");
  return value;
}

/** Minimal recursive-descent parser used only to reject duplicate object keys (SPEC §3.1). */
class StrictJsonParser {
  pos = 0;
  constructor(private text: string) {}
  skipWs() {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos]!)) this.pos++;
  }
  parseValue(): Json {
    this.skipWs();
    const c = this.text[this.pos];
    if (c === "{") return this.parseObject();
    if (c === "[") return this.parseArray();
    if (c === '"') return this.parseString();
    if (c === "t") return this.parseLiteral("true", true);
    if (c === "f") return this.parseLiteral("false", false);
    if (c === "n") return this.parseLiteral("null", null);
    return this.parseNumber();
  }
  parseLiteral<T extends Json>(word: string, value: T): T {
    if (this.text.slice(this.pos, this.pos + word.length) !== word) {
      throw new LedgerError("E_INPUT", "malformed JSON literal");
    }
    this.pos += word.length;
    return value;
  }
  parseNumber(): number {
    const start = this.pos;
    while (this.pos < this.text.length && /[-+0-9.eE]/.test(this.text[this.pos]!)) this.pos++;
    const raw = this.text.slice(start, this.pos);
    const n = Number(raw);
    if (raw === "" || Number.isNaN(n)) throw new LedgerError("E_INPUT", "malformed JSON number");
    return n;
  }
  parseString(): string {
    this.pos++; // opening quote
    let s = "";
    while (this.pos < this.text.length && this.text[this.pos] !== '"') {
      if (this.text[this.pos] === "\\") {
        s += (this.text[this.pos] ?? "") + (this.text[this.pos + 1] ?? "");
        this.pos += 2;
      } else {
        s += this.text[this.pos];
        this.pos++;
      }
    }
    if (this.text[this.pos] !== '"') throw new LedgerError("E_INPUT", "unterminated JSON string");
    this.pos++; // closing quote
    return JSON.parse('"' + s + '"');
  }
  parseArray(): Json[] {
    this.pos++; // [
    const items: Json[] = [];
    this.skipWs();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return items;
    }
    for (;;) {
      items.push(this.parseValue());
      this.skipWs();
      if (this.text[this.pos] === ",") {
        this.pos++;
        continue;
      }
      if (this.text[this.pos] === "]") {
        this.pos++;
        return items;
      }
      throw new LedgerError("E_INPUT", "malformed JSON array");
    }
  }
  parseObject(): { [k: string]: Json } {
    this.pos++; // {
    const obj: { [k: string]: Json } = {};
    const seen = new Set<string>();
    this.skipWs();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return obj;
    }
    for (;;) {
      this.skipWs();
      if (this.text[this.pos] !== '"') throw new LedgerError("E_INPUT", "expected JSON object key");
      const key = this.parseString();
      if (seen.has(key)) throw new LedgerError("E_INPUT", "duplicate object key", key);
      seen.add(key);
      this.skipWs();
      if (this.text[this.pos] !== ":") throw new LedgerError("E_INPUT", "malformed JSON object");
      this.pos++;
      obj[key] = this.parseValue();
      this.skipWs();
      if (this.text[this.pos] === ",") {
        this.pos++;
        continue;
      }
      if (this.text[this.pos] === "}") {
        this.pos++;
        return obj;
      }
      throw new LedgerError("E_INPUT", "malformed JSON object");
    }
  }
}
