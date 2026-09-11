/**
 * Redaction totality (SPEC invariant 5.5 / property P5): any attribute value stored under a
 * key outside this package's published allowlist is replaced, at admission time, with a
 * digest wrapper. The raw value is never canonicalized into the chain, never returned, and
 * never logged — there is nothing left to leak later.
 */
import { LedgerError, canonical, digestOf, Json } from "./canonical.js";

export const REDACTION_ALLOWLIST: readonly string[] = [
  "durationMs",
  "statusCode",
  "httpMethod",
  "itemCount",
  "bytesTransferred",
  "retryCount",
  "cacheHit",
  "exitCode",
  "supersedes",
  "reason",
].sort();

const MAX_ATTRIBUTES_BYTES = 65536; // 64 KiB canonical, SPEC §3.1
const MAX_ATTRIBUTES_DEPTH = 8;

function depthOf(value: Json, current = 0): number {
  if (current > MAX_ATTRIBUTES_DEPTH + 1) return current;
  if (Array.isArray(value)) return value.length === 0 ? current : Math.max(...value.map((v) => depthOf(v, current + 1)));
  if (value !== null && typeof value === "object") {
    const vals = Object.values(value);
    return vals.length === 0 ? current : Math.max(...vals.map((v) => depthOf(v, current + 1)));
  }
  return current;
}

/**
 * Redacts top-level attribute keys not on the allowlist, replacing the whole subtree with
 * `{ "$digest": sha256(canonical(value)) }`. Runs before the entry is ever canonicalized for
 * the chain, so a non-allowlisted value is never hashed into, or recoverable from, any output.
 */
export function redactAttributes(attributes: Json | undefined, pointer: string): Record<string, Json> {
  if (attributes === undefined) return {};
  if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) {
    throw new LedgerError("E_INPUT", "attributes must be a JSON object", pointer);
  }
  const depth = depthOf(attributes);
  if (depth > MAX_ATTRIBUTES_DEPTH) {
    throw new LedgerError("E_LIMIT", "attributes exceed maximum depth", pointer, { limit: "attributes.depth", observed: depth });
  }
  let canonicalText: string;
  try {
    canonicalText = canonical(attributes);
  } catch {
    throw new LedgerError("E_INPUT", "attributes are not canonicalizable", pointer);
  }
  const size = Buffer.byteLength(canonicalText, "utf8");
  if (size > MAX_ATTRIBUTES_BYTES) {
    throw new LedgerError("E_LIMIT", "attributes exceed maximum canonical size", pointer, { limit: "attributes.bytes", observed: size });
  }
  const out: Record<string, Json> = {};
  for (const key of Object.keys(attributes).sort()) {
    const value = (attributes as Record<string, Json>)[key]!;
    out[key] = REDACTION_ALLOWLIST.includes(key) ? value : ({ $digest: digestOf(value) } as Json);
  }
  return out;
}
