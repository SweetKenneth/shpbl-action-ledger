# Agent Action Evidence Ledger

**An append-only, hash-linked evidence ledger for autonomous agent actions, with a verifier
that needs nothing but the exported file.**

MIT licensed · zero runtime dependencies · MCP stdio server · TypeScript

## The security problem

When an autonomous agent acts on production systems, the record of what it did usually lives
in the same place as the agent: its own logs, its own database, its own operator's storage.
That record is exactly what an attacker — or an embarrassed operator — edits first. A reviewer
asking *what did this agent actually do, in what order, and was the record changed afterwards?*
has no way to answer without trusting the party under review.

## What this product does

It records every agent proposal, execution, redaction and annotation as an entry in an
append-only chain. Each entry's SHA-256 digest binds to its predecessor over a canonical form,
so mutating, reordering, inserting or truncating any entry is detectable. An export is
self-contained: `verify_ledger` is a pure function of the export document's own bytes and
performs no other I/O, so a third party can check the history without trusting the agent
runtime, the operator's storage, or this package's live process.

It never prevents, approves or executes an action. It observes and attests.

### Major capabilities

- **Append-only history.** No operation updates or deletes an entry. Correction is a new
  `redaction` entry naming the superseded sequence number.
- **Chain integrity over a canonical form.** SHA-256 only; no short or non-cryptographic hash
  anywhere.
- **Redaction totality.** Attribute values under non-allowlisted keys are replaced with a
  `{ "$digest": ... }` wrapper at admission — never canonicalized into the chain, returned, or
  logged in clear.
- **Independent verification.** The verifier is pure and offline, and needs no other package.
- **Never fails open.** A rejected durable append leaves the chain head unchanged and consumes
  no sequence number.
- **Anchor point for external notarisation.** `headDigest` is reported separately from chain
  validity, so anchoring status is never confused with cryptographic integrity.

## Install and run

Prerequisites: [Bun](https://bun.sh) 1.1+ (or Node 22+ with a TypeScript loader). No install
step is required beyond the clone, because there are no runtime dependencies.

```bash
git clone https://github.com/SweetKenneth/shpbl-action-ledger.git
cd shpbl-action-ledger
bun install                    # dev types only
bun test                       # conformance suite
bun run scripts/symbol-scan.ts # build-failing forbidden-symbol scan
bun src/mcp-server.ts          # MCP server: newline-delimited JSON-RPC 2.0 on stdin/stdout
```

### MCP configuration

```json
{
  "mcpServers": {
    "action-ledger": {
      "command": "bun",
      "args": ["/absolute/path/to/shpbl-action-ledger/src/mcp-server.ts"]
    }
  }
}
```

### Tool surface

| Tool | Purpose |
|---|---|
| `record_action` | append one `proposal` / `execution` / `redaction` / `annotation` entry |
| `export_ledger` | self-contained, independently verifiable range export |
| `verify_ledger` | pure verdict from an export document's own bytes; no live-store I/O |
| `describe_policy` | redaction allowlist, hash algorithm, canonicalization/export versions, limits |

### Worked example

`examples/worked-example.ts` records a proposal, its execution, a redaction of a mistaken
entry, exports the range, tampers with one byte, and shows the verifier rejecting the tampered
export while accepting the original.

```bash
bun examples/worked-example.ts
```

## Verification results

60 conformance tests, 158 assertions: specification properties P1–P12, every §7 failure mode,
canonicalization test vectors, and the MCP JSON-RPC surface. The forbidden-symbol scan covers
8 source files and fails the build on any network, filesystem-write or process-execution
symbol. Strict typecheck is clean. Runtime dependencies: **zero**.

## Security boundaries

- No network access, no ambient filesystem writes, no process execution.
- Durable persistence happens only through a sink the caller supplies.
- Errors are structured and value-free: a fixed code, a fixed phrase from this package's own
  vocabulary, and a JSON pointer — never a caller-supplied value.
- This is an evidence tool for the operator's own agent systems. It does not gate, approve or
  prevent any action.

See `SECURITY.md` for the full threat model.

## Known limitations

- An attacker with write access to the durable sink **and** the ability to recompute the chain
  from genesis can forge a self-consistent history. The mitigation is periodic external
  anchoring of `headDigest` to a store the attacker cannot rewrite. This package defines the
  anchor point and format; it does not ship an anchoring service.
- The ledger cannot attest that a recorded action was *actually performed* — only that the
  runtime asserted it, at that point in the chain, and has not edited the assertion since.

## Provenance

Discovered with SHPBL. This product originated through cross-capability composition in the
SHPBL capability library. Its public implementation was independently built from a published
behavioural specification. SHPBL's proprietary capability library, discovery system, harvested
implementation bodies, and private provenance machinery are not included.

- Public behavioural specification: <https://github.com/SweetKenneth/shpbl-spec-action-ledger>
  (a copy ships here as `SPEC-agent-action-evidence-ledger.md`)
- SHPBL: <https://shpbl.com>
- Details: `PROVENANCE.md`

## Tenable status

Independent open-source project being prepared for submission to the Tenable CyberAgents
Exchange. Not submitted to, reviewed by, approved by, certified by, validated by or endorsed by
Tenable or any other vendor.

## SHPBL Agent Evidence series

Independently installable, interoperable at the evidence-record boundary:

- [shpbl-action-ledger](https://github.com/SweetKenneth/shpbl-action-ledger) — agent action evidence ledger
- [shpbl-handoff-attestor](https://github.com/SweetKenneth/shpbl-handoff-attestor) — cross-agent handoff attestation
- [shpbl-drift-sentinel](https://github.com/SweetKenneth/shpbl-drift-sentinel) — agent behaviour drift detection
- [shpbl-retrieval-auditor](https://github.com/SweetKenneth/shpbl-retrieval-auditor) — retrieval context provenance
- [shpbl-canary-chain](https://github.com/SweetKenneth/shpbl-canary-chain) — synthetic canary evidence chain

## Licence

MIT — Copyright (c) 2026 Kenneth E. Sweet Jr. See `LICENSE`.
