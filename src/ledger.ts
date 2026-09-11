/**
 * Append-only, hash-linked action ledger (SPEC §5, §6). One instance is one chain: entries
 * begin at sequence 0 and each digest binds to its predecessor and the operator sink.
 */
import { LedgerError, Json, canonical, sha256 } from "./canonical.js";
import { REDACTION_ALLOWLIST, redactAttributes } from "./redaction.js";
import { LedgerSink, InMemorySink } from "./sink.js";

export const GENESIS_DIGEST = "0".repeat(64);
export const EXPORT_FORMAT = "aael-export/1";
export const CANONICALIZATION_VERSION = "1";
export const HASH_ALGORITHM = "SHA-256";
export const MAX_FUTURE_SKEW_SECONDS = 300;
export const MAX_ACTOR_LEN = 256;
export const MAX_ACTION_LEN = 256;
export const MAX_SUBJECT_LEN = 1024;
export const MAX_LINKS = 32;
export const MAX_EXPORT_ENTRIES = 100_000;

export type EntryKind = "proposal" | "execution" | "redaction" | "annotation";
export type Outcome = "pending" | "success" | "failure" | "refused";

export interface RecordActionInput {
  kind: EntryKind;
  actor: string;
  action: string;
  subject?: string;
  outcome?: Outcome;
  attributes?: Json;
  links?: string[];
  occurredAt: string;
}

export interface RecordedEntry {
  sequence: number;
  kind: EntryKind;
  actor: string;
  action: string;
  subject: string | null;
  outcome: Outcome | null;
  attributes: Record<string, Json>;
  links: string[];
  occurredAt: string;
  recordedAt: string;
  prevDigest: string;
  entryDigest: string;
  clockSkewFlagged: boolean;
}

const KINDS: EntryKind[] = ["proposal", "execution", "redaction", "annotation"];
const OUTCOMES: Outcome[] = ["pending", "success", "failure", "refused"];
const DIGEST_HEX_64 = /^[0-9a-f]{64}$/;

function entryBody(e: Omit<RecordedEntry, "entryDigest">): Json {
  return {
    sequence: e.sequence,
    kind: e.kind,
    actor: e.actor,
    action: e.action,
    subject: e.subject,
    outcome: e.outcome,
    attributes: e.attributes as unknown as Json,
    links: e.links as unknown as Json,
    occurredAt: e.occurredAt,
    recordedAt: e.recordedAt,
    prevDigest: e.prevDigest,
    clockSkewFlagged: e.clockSkewFlagged,
  };
}

export function computeEntryDigest(e: Omit<RecordedEntry, "entryDigest">): string {
  return sha256(e.prevDigest + canonical(entryBody(e)));
}

/** now() is injectable only for tests; production code always uses the wall clock. */
export interface LedgerOptions {
  sink?: LedgerSink;
  now?: () => Date;
}

export class Ledger {
  private entries: RecordedEntry[] = [];
  private superseded = new Set<number>();
  private sink: LedgerSink;
  private now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: LedgerOptions = {}) {
    this.sink = options.sink ?? new InMemorySink();
    this.now = options.now ?? (() => new Date());
  }

  /** SPEC §3.1 / invariant 5.7: serialized so exactly one entry receives each sequence. */
  async recordAction(input: RecordActionInput): Promise<RecordedEntry> {
    const task = this.queue.then(() => this.recordActionSerialized(input));
    // Never let one rejected append poison the queue for later callers.
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async recordActionSerialized(input: RecordActionInput): Promise<RecordedEntry> {
    if (!KINDS.includes(input?.kind as EntryKind)) {
      throw new LedgerError("E_INPUT", "kind must be one of proposal|execution|redaction|annotation", "kind");
    }
    const actor = requireBoundedString(input.actor, "actor", 1, MAX_ACTOR_LEN);
    const action = requireBoundedString(input.action, "action", 1, MAX_ACTION_LEN);
    const subject = input.subject == null ? null : requireBoundedString(input.subject, "subject", 0, MAX_SUBJECT_LEN);

    let outcome: Outcome | null = null;
    if (input.kind === "execution") {
      if (!OUTCOMES.includes(input.outcome as Outcome)) {
        throw new LedgerError("E_INPUT", "outcome is required for kind=execution", "outcome");
      }
      outcome = input.outcome!;
    } else if (input.outcome !== undefined) {
      if (!OUTCOMES.includes(input.outcome as Outcome)) {
        throw new LedgerError("E_INPUT", "outcome must be a recognised value", "outcome");
      }
      outcome = input.outcome;
    }

    const links = requireLinks(input.links);
    const occurredAt = requireTimestamp(input.occurredAt, "occurredAt");
    const attributes = redactAttributes(input.attributes, "attributes");

    if (input.kind === "redaction") {
      const supersedesRaw = input.attributes && (input.attributes as any).supersedes;
      if (typeof supersedesRaw !== "number" || !Number.isInteger(supersedesRaw) || supersedesRaw < 0) {
        throw new LedgerError("E_INPUT", "redaction requires attributes.supersedes as a recorded sequence number", "attributes.supersedes");
      }
      if (supersedesRaw >= this.entries.length) {
        throw new LedgerError("E_INPUT", "redaction references an unknown sequence", "attributes.supersedes");
      }
    }

    const recordedAt = this.now().toISOString();
    const occurredMs = Date.parse(occurredAt);
    const recordedMs = Date.parse(recordedAt);
    const skewSeconds = (occurredMs - recordedMs) / 1000;
    let clockSkewFlagged = false;
    if (skewSeconds > MAX_FUTURE_SKEW_SECONDS) {
      throw new LedgerError("E_CLOCK", "occurredAt is beyond the published future-skew bound", "occurredAt");
    }
    if (skewSeconds > 0) clockSkewFlagged = true;

    const sequence = this.entries.length;
    const prevDigest = this.entries.length ? this.entries[this.entries.length - 1]!.entryDigest : GENESIS_DIGEST;
    const body: Omit<RecordedEntry, "entryDigest"> = {
      sequence,
      kind: input.kind,
      actor,
      action,
      subject,
      outcome,
      attributes,
      links,
      occurredAt,
      recordedAt,
      prevDigest,
      clockSkewFlagged,
    };
    const entryDigest = computeEntryDigest(body);
    const entry: RecordedEntry = { ...body, entryDigest };

    try {
      await this.sink.append({ sequence, prevDigest, entry: entryBody(body) });
    } catch {
      // Invariant 5.7: a failed append leaves the chain head unchanged and consumes no sequence.
      throw new LedgerError("E_STORE", "durable append was rejected by the sink");
    }

    this.entries.push(entry);
    if (input.kind === "redaction") {
      this.superseded.add((input.attributes as any).supersedes as number);
    }
    return entry;
  }

  exportLedger(input: { from?: number; to?: number; includeRedacted?: boolean } = {}): Json {
    const total = this.entries.length;
    const from = input.from ?? 0;
    const to = input.to ?? (total === 0 ? -1 : total - 1);
    if (from < 0 || to < from || to > total - 1) {
      throw new LedgerError("E_INPUT", "export range is out of bounds", "from/to");
    }
    const includeRedacted = input.includeRedacted ?? true;
    const rangeSize = to - from + 1;
    if (rangeSize > MAX_EXPORT_ENTRIES) {
      throw new LedgerError("E_LIMIT", "export exceeds the published entry limit", "to", { limit: "export.entries", observed: rangeSize });
    }

    let selected = this.entries.slice(from, to + 1);
    if (!includeRedacted) selected = selected.filter((e) => !this.superseded.has(e.sequence) && e.kind !== "redaction");

    const rendered = selected.map((e) => ({
      ...(entryBody(e) as Record<string, Json>),
      entryDigest: e.entryDigest,
      view: this.superseded.has(e.sequence) ? "superseded" : "visible",
    })) as unknown as Json;

    const completeFromGenesis = from === 0;
    const doc: Record<string, Json> = {
      format: EXPORT_FORMAT,
      canonicalization: CANONICALIZATION_VERSION,
      hash: HASH_ALGORITHM,
      genesisDigest: GENESIS_DIGEST,
      headDigest: total === 0 ? GENESIS_DIGEST : this.entries[total - 1]!.entryDigest,
      range: { from, to, completeFromGenesis },
      count: selected.length,
      anchor: { status: "unanchored" },
      entries: rendered,
    };
    if (!completeFromGenesis && this.entries.length) {
      doc.precedingDigest = from === 0 ? GENESIS_DIGEST : this.entries[from - 1]!.entryDigest;
    }
    return doc;
  }

  describePolicy(): Json {
    return {
      redactionAllowlist: REDACTION_ALLOWLIST as unknown as Json,
      hashAlgorithm: HASH_ALGORITHM,
      canonicalizationVersion: CANONICALIZATION_VERSION,
      exportFormatVersion: EXPORT_FORMAT,
      maxFutureSkewSeconds: MAX_FUTURE_SKEW_SECONDS,
      limits: {
        actorLength: MAX_ACTOR_LEN,
        actionLength: MAX_ACTION_LEN,
        subjectLength: MAX_SUBJECT_LEN,
        maxLinks: MAX_LINKS,
        attributesBytes: 65536,
        attributesDepth: 8,
        exportEntries: MAX_EXPORT_ENTRIES,
      },
      anchoringPolicy: "unanchored: this package defines the anchor point and format but ships no anchoring service",
    };
  }

  get headDigest(): string {
    return this.entries.length ? this.entries[this.entries.length - 1]!.entryDigest : GENESIS_DIGEST;
  }

  get count(): number {
    return this.entries.length;
  }
}

function requireBoundedString(value: unknown, pointer: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new LedgerError("E_INPUT", `expected a string of length ${min}-${max}`, pointer);
  }
  return value;
}

function requireTimestamp(value: unknown, pointer: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(value)) {
    throw new LedgerError("E_INPUT", "expected an RFC 3339 UTC timestamp", pointer);
  }
  return value;
}

function requireLinks(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LINKS) {
    throw new LedgerError("E_LIMIT", "links exceed the maximum count", "links", { limit: "links.count", observed: Array.isArray(value) ? value.length : 0 });
  }
  return value.map((v, i) => {
    if (typeof v !== "string" || !DIGEST_HEX_64.test(v)) {
      throw new LedgerError("E_INPUT", "each link must be a 64-character lowercase hex digest", `links/${i}`);
    }
    return v;
  });
}
