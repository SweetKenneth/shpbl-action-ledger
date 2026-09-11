# Security policy and threat model

## In scope

- detection of mutation, insertion, reordering, and truncation of recorded agent-action history
- producing evidence a reviewer can check independently of the agent runtime, this package's
  own process, and the operator's storage
- redaction of non-allowlisted attribute values before they ever enter the chain

## Out of scope, stated plainly

- An attacker with write access to the durable sink *and* the ability to recompute the chain
  from genesis can forge a self-consistent history. Mitigation is periodic external anchoring
  of `headDigest` to a store the attacker cannot rewrite. This package defines the anchor point
  and format; it does not ship an anchoring service.
- The ledger cannot attest that a recorded action was *actually performed* — only that the
  runtime asserted it, at that point in the chain, and has not edited the assertion.

## Refused capabilities

Executing actions, capturing credentials, making outbound network calls, reading files the
caller did not supply, resolving identifiers. Enforced by `scripts/symbol-scan.ts`, which fails
the build on any network, filesystem-write, process-execution or foreign-closure symbol.

## Data handling

Attribute values under keys outside the published redaction allowlist are replaced, at
admission time, with a `{ "$digest": ... }` wrapper before canonicalization. The raw value is
never canonicalized into the chain, never returned, and never logged. Errors are structured and
value-free: a fixed code, a fixed phrase from this package's own vocabulary, and a JSON
pointer — never a caller-supplied value.

## Misuse boundary

This is an evidence tool for the operator's own agent systems. It does not gate, approve, or
prevent any action; it observes and attests after the fact. It cannot observe a third-party
system.

## Reporting a vulnerability

Open a GitHub security advisory on this repository, or contact the maintainer directly. Please
do not open a public issue for a suspected vulnerability before it has been triaged.
