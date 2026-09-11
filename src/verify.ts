/**
 * Independent ledger verifier (SPEC §3.3, §4.3, invariant 5.6 / property P6).
 * Pure function of its input export document: no I/O, no reference to any live
 * `Ledger` instance, no network or filesystem access. Runnable with only this
 * published package installed.
 */
import { Json, canonical, sha256 } from "./canonical.js";
import { GENESIS_DIGEST, EXPORT_FORMAT } from "./ledger.js";

export type FailureReason =
  | "digest-mismatch"
  | "broken-link"
  | "sequence-gap"
  | "sequence-reorder"
  | "genesis-mismatch"
  | "malformed-entry"
  | "unsupported-format";

export type AnchorStatus = "unanchored" | "present-unverified" | "verified" | "invalid";

export interface VerificationFailure {
  reason: FailureReason;
  sequence?: number;
  expectedDigest?: string;
  actualDigest?: string;
  detail?: string;
}

export interface VerificationResult {
  valid: boolean;
  checkedEntries: number;
  failure: VerificationFailure | null;
  anchorStatus: AnchorStatus;
}

function fail(checkedEntries: number, anchorStatus: AnchorStatus, failure: VerificationFailure): VerificationResult {
  return { valid: false, checkedEntries, failure, anchorStatus };
}

function isPlainObject(v: unknown): v is Record<string, Json> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function anchorStatusOf(doc: Record<string, Json>): AnchorStatus {
  const anchor = doc.anchor;
  if (!isPlainObject(anchor)) return "unanchored";
  const status = anchor.status;
  if (status === "present-unverified" || status === "verified" || status === "invalid") return status;
  return "unanchored";
}

/**
 * Recomputes every entry digest from the entry bodies present in `doc.entries`,
 * checking the hash chain, sequence density/order and, when the export begins at
 * genesis, the genesis digest itself. Ranged exports that do not start at genesis
 * are verified against `precedingDigest` instead (SPEC §4.3).
 */
export function verifyLedger(exportDoc: unknown): VerificationResult {
  if (!isPlainObject(exportDoc)) {
    return fail(0, "unanchored", { reason: "malformed-entry", detail: "export is not a JSON object" });
  }
  const doc = exportDoc;
  const anchorStatus = anchorStatusOf(doc);

  if (doc.format !== EXPORT_FORMAT) {
    return fail(0, anchorStatus, { reason: "unsupported-format", detail: `expected format ${EXPORT_FORMAT}` });
  }
  if (!Array.isArray(doc.entries)) {
    return fail(0, anchorStatus, { reason: "malformed-entry", detail: "entries must be an array" });
  }

  const entries = doc.entries;
  const range = isPlainObject(doc.range) ? doc.range : {};
  const from = typeof range.from === "number" ? range.from : 0;
  const completeFromGenesis = range.completeFromGenesis === true || from === 0;

  let prevDigest: string;
  if (completeFromGenesis) {
    if (doc.genesisDigest !== GENESIS_DIGEST) {
      return fail(0, anchorStatus, { reason: "genesis-mismatch", expectedDigest: GENESIS_DIGEST, actualDigest: String(doc.genesisDigest) });
    }
    prevDigest = GENESIS_DIGEST;
  } else {
    if (typeof doc.precedingDigest !== "string") {
      return fail(0, anchorStatus, { reason: "malformed-entry", detail: "ranged export missing precedingDigest" });
    }
    prevDigest = doc.precedingDigest;
  }

  let expectedSequence = from;
  let checked = 0;
  for (const raw of entries) {
    if (!isPlainObject(raw)) {
      return fail(checked, anchorStatus, { reason: "malformed-entry", sequence: expectedSequence, detail: "entry is not a JSON object" });
    }
    const entry = raw;
    const { entryDigest, view: _view, ...body } = entry as Record<string, Json> & { entryDigest?: Json; view?: Json };
    const sequence = (body as Record<string, Json>).sequence;

    if (typeof sequence !== "number" || typeof entryDigest !== "string") {
      return fail(checked, anchorStatus, { reason: "malformed-entry", sequence: expectedSequence, detail: "entry missing sequence or entryDigest" });
    }
    if (sequence !== expectedSequence) {
      return fail(checked, anchorStatus, {
        reason: sequence < expectedSequence ? "sequence-reorder" : "sequence-gap",
        sequence,
        detail: `expected sequence ${expectedSequence}`,
      });
    }
    if ((body as Record<string, Json>).prevDigest !== prevDigest) {
      return fail(checked, anchorStatus, { reason: "broken-link", sequence, expectedDigest: prevDigest, actualDigest: String((body as any).prevDigest) });
    }

    let recomputed: string;
    try {
      recomputed = sha256(prevDigest + canonical(body as Json));
    } catch {
      return fail(checked, anchorStatus, { reason: "malformed-entry", sequence, detail: "entry body is not canonicalizable" });
    }
    if (recomputed !== entryDigest) {
      return fail(checked, anchorStatus, { reason: "digest-mismatch", sequence, expectedDigest: recomputed, actualDigest: entryDigest });
    }

    prevDigest = entryDigest;
    expectedSequence += 1;
    checked += 1;
  }

  if (typeof doc.headDigest === "string" && entries.length > 0 && doc.headDigest !== prevDigest) {
    return fail(checked, anchorStatus, { reason: "digest-mismatch", expectedDigest: prevDigest, actualDigest: doc.headDigest, detail: "headDigest does not match recomputed chain head" });
  }

  return { valid: true, checkedEntries: checked, failure: null, anchorStatus };
}
