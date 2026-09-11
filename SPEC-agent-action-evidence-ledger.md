# SPEC — Agent Action Evidence Ledger

Status: **public behaviour specification, version 1.0.** Specification release only.
No implementation, Tenable listing, Exchange submission, PR, or Contribution Agreement
acceptance is authorized by this document.

Product form: MCP server + skill.
Written from product behaviour and capability intent. No harvested body was quoted,
translated, or structurally reproduced in producing this specification.

---

## 1. Purpose

An autonomous agent proposes and performs actions. After the fact, nobody can prove
what it actually did, in what order, or whether the record was edited afterwards.

This product records agent actions as an append-only, hash-linked ledger that a
**third party can verify without trusting the agent runtime, the operator's storage,
or this package's own process**. Verification requires only the exported ledger file
and the published verifier.

Non-goal: preventing, approving, or executing actions. The ledger observes and
attests; it never gates.

## 2. Definitions

- **Entry** — one recorded fact about an action: a proposal, an execution result, a
  redaction, or an operator annotation.
- **Canonical form** — UTF-8 JSON with object keys sorted by Unicode code point, no insignificant
  whitespace, integers in base-10, and every string normalized to Unicode NFC before encoding.
  Arrays retain order. The canonicalization version fixes this complete rule and its test vectors.
- **Entry digest** — SHA-256 over the previous entry's digest concatenated with the
  canonical form of this entry.
- **Ledger** — an ordered sequence of entries beginning at a genesis entry.
- **Export** — a self-contained serialization of a ledger suitable for handing to a
  reviewer.

## 3. Inputs

### 3.1 `record_action`

| Field | Type | Required | Notes |
|---|---|---|---|
| `kind` | `"proposal" \| "execution" \| "redaction" \| "annotation"` | yes | |
| `actor` | string, 1–256 chars | yes | opaque caller-chosen agent label |
| `action` | string, 1–256 chars | yes | e.g. `tool.call`, `file.write` |
| `subject` | string, 0–1024 chars | no | what the action targets |
| `outcome` | `"pending" \| "success" \| "failure" \| "refused"` | conditional | required when `kind = "execution"` |
| `attributes` | JSON object, depth ≤ 8, ≤ 64 KiB canonical | no | free-form detail |
| `links` | array of external digests (hex, 64 chars), ≤ 32 | no | binds to other products' records |
| `occurredAt` | RFC 3339 UTC timestamp | yes | caller-supplied; future skew beyond the policy bound is flagged |

Rejected at admission: non-finite numbers, `undefined`, functions, symbols, cyclic
structures, `NaN` keys, duplicate object keys, values exceeding the size or depth
bounds. Rejection is an error return, never a silent coercion.

### 3.2 `export_ledger`
`{ from?: sequence, to?: sequence, includeRedacted?: boolean }`

### 3.3 `verify_ledger`
`{ export: <ledger export document> }` — no other input; verification never consults
the live store.

### 3.4 `describe_policy`
No input. Returns the active redaction allowlist, hash algorithm, canonicalization
version, export format version, maximum future-clock skew, entry/export size limits, and
anchoring policy. Policy changes require a new format or canonicalization version when they
affect verification.

## 4. Outputs

### 4.1 Recorded entry (returned by `record_action`)
```
{
  "sequence": 42,
  "kind": "execution",
  "actor": "planner-1",
  "action": "tool.call",
  "subject": "search",
  "outcome": "success",
  "attributes": { "durationMs": 812, "apiKey": { "$digest": "9f2c…" } },
  "links": [],
  "occurredAt": "2026-09-11T18:04:22Z",
  "recordedAt": "2026-09-11T18:04:22Z",
  "prevDigest": "1a0b…",
  "entryDigest": "7e41…"
}
```

### 4.2 Export document
```
{
  "format": "aael-export/1",
  "canonicalization": "1",
  "hash": "SHA-256",
  "genesisDigest": "0000…",
  "headDigest": "7e41…",
  "range": { "from": 0, "to": 42, "completeFromGenesis": true },
  "count": 43,
  "anchor": { "status": "unanchored" },
  "entries": [ … ]
}
```

### 4.3 Verification result
```
{
  "valid": false,
  "checkedEntries": 43,
  "failure": {
    "reason": "digest-mismatch",
    "sequence": 17,
    "expectedDigest": "c30d…",
    "actualDigest": "b881…"
  }
}
```
`reason` ∈ `digest-mismatch`, `broken-link`, `sequence-gap`, `sequence-reorder`,
`genesis-mismatch`, `malformed-entry`, `unsupported-format`. The result also reports
`anchorStatus` as `unanchored`, `present-unverified`, `verified`, or `invalid`; chain validity
and anchor validity are separate facts. A ranged export that does not begin at genesis is
verifiable only when it carries the preceding digest and reports `completeFromGenesis: false`.

## 5. Invariants

1. **Append-only.** No public operation updates or deletes an entry. Correction is a
   new `redaction` entry naming the superseded sequence number.
2. **Chain integrity.** For every entry *n* > genesis:
   `entryDigest(n) = SHA-256(entryDigest(n-1) ‖ canonical(n))`.
3. **Dense monotonic sequence.** Sequence numbers start at 0 and increase by exactly 1.
4. **Canonical determinism.** `canonical(e)` is byte-identical across platforms,
   process runs, key insertion orders, and Unicode normalization forms of equal strings.
5. **Redaction totality.** No value under a non-allowlisted key appears in clear in any
   output, including error messages, logs, and verification failures.
6. **Verifier independence.** `verify_ledger` reaches a verdict using only the export
   document and the published package. It performs no I/O other than reading its input.
7. **Recording never fails open.** If durable append cannot be confirmed,
   `record_action` returns an error and the entry does not become part of the chain. Failed
   appends consume no sequence number. Concurrent appends are serialized atomically by the
   sink contract, so exactly one entry receives each sequence and predecessor digest.
8. **No egress.** The package makes no network call and performs no filesystem write
   outside the operator-supplied sink.

## 6. State transitions

```
(empty) --initialize--> SEALED_GENESIS
SEALED_GENESIS --record_action--> OPEN(head=d1)
OPEN(head=dn) --record_action--> OPEN(head=dn+1)
OPEN --export_ledger--> OPEN            (read-only; head unchanged)
OPEN --append failure--> OPEN           (head unchanged; entry discarded)
any --verify_ledger--> unchanged        (pure function of its input)
```
An entry with `kind = "redaction"` transitions the *referenced* entry's derived view
state from `visible` to `superseded`. The referenced entry's bytes and digest never
change; only the rendered view changes.

## 7. Failure modes

| Condition | Behaviour |
|---|---|
| Non-canonicalizable input | `E_INPUT` with the offending JSON pointer, never the value |
| Size/depth limit exceeded | `E_LIMIT` with limit name and observed size |
| Durable append rejected by sink | `E_STORE`, chain head unchanged, entry discarded |
| Corrupt export (truncated JSON) | `valid: false`, `reason: malformed-entry` |
| Export from a newer format version | `valid: false`, `reason: unsupported-format` |
| Redaction referencing unknown sequence | `E_INPUT`; no entry recorded |
| Clock skew (`occurredAt` after `recordedAt`) | within the published bound: recorded and flagged; beyond it: `E_CLOCK`, no append |
| Concurrent append conflict | loser retries against the new head or returns `E_CONFLICT`; no sequence is consumed |
| Export exceeds published entry/byte limit | `E_LIMIT`; no partial document is presented as a complete export |

Errors are structured and value-free: identifiers, limits, and pointers only.

## 8. Security boundaries

**In scope**
- Detection of mutation, insertion, reordering, and truncation of recorded history.
- Producing evidence a reviewer can check independently of the agent runtime.

**Out of scope, stated plainly**
- An attacker with write access to the sink *and* the ability to recompute the chain
  from genesis can forge a self-consistent history. Mitigation is periodic external
  anchoring of `headDigest` to a store the attacker cannot rewrite. The specification
  defines the anchor point and format; it does not ship an anchoring service.
- The ledger cannot attest that a recorded action was *actually performed* — only that
  the runtime asserted it, at that point in the chain, and has not edited the assertion.

**Refused capabilities:** executing actions, capturing credentials, making outbound
calls, reading files the caller did not supply, resolving identifiers.

## 9. Worked example

1. Agent proposes `file.write` on `/etc/hosts`. `record_action(kind=proposal)` →
   sequence 0, digest `d0`.
2. Human declines; agent records `kind=annotation, action=policy.decline` → sequence 1,
   digest `d1 = H(d0 ‖ canonical(e1))`.
3. Agent instead writes `/tmp/hosts.draft`; `kind=execution, outcome=success` →
   sequence 2, digest `d2`.
4. An operator later edits sequence 1 in the stored file to read `policy.approve`.
5. `verify_ledger` on the export returns
   `{ valid: false, reason: "digest-mismatch", sequence: 1 }`, because `d1` no longer
   matches the recomputed digest, and every later link inherits the break.

## 10. Externally testable properties

| ID | Property |
|---|---|
| P1 | Mutating any byte of any entry in an export makes verification fail at that sequence. |
| P2 | Inserting, deleting, reordering, or truncating entries makes verification fail. |
| P3 | Canonical bytes are invariant to object-key insertion order. |
| P4 | Canonical bytes are equal for strings equal after a defined Unicode normalization. |
| P5 | For random inputs containing secret-shaped values under non-allowlisted keys, no raw value occurs in any output, error, or log. |
| P6 | A ledger exported by the package verifies using only the published verifier binary, with no other package installed. |
| P7 | Sequence numbers of an exported ledger are exactly `0..count-1`. |
| P8 | A simulated store failure leaves `headDigest` unchanged and `count` unchanged. |
| P9 | A static scan of the published build finds no network, process-spawn, or ambient filesystem-write symbol. |
| P10 | Two independent runs recording the same entry sequence produce identical digests. |
| P11 | Published canonicalization vectors produce byte-identical bytes and digests in two independent implementations. |
| P12 | Under concurrent append tests, sequences remain dense and each accepted entry has exactly one predecessor. |
