/** Operator-supplied durable append sink (SPEC invariant 5.7 / §5, "no egress"). */
import { Json } from "./canonical.js";

export interface SinkAppendInput {
  sequence: number;
  prevDigest: string;
  entry: Json;
}

/** Implemented by the operator. May throw/reject to simulate a durable-append failure. */
export interface LedgerSink {
  append(input: SinkAppendInput): void | Promise<void>;
}

/** Default in-process sink: durable within the process only. No filesystem or network I/O. */
export class InMemorySink implements LedgerSink {
  private appended: SinkAppendInput[] = [];
  append(input: SinkAppendInput): void {
    this.appended.push(input);
  }
  get length(): number {
    return this.appended.length;
  }
}

/** Test/demo helper: a sink that fails every Nth append with no partial write. */
export class FlakySink implements LedgerSink {
  private calls = 0;
  constructor(private failEvery: number, private inner: LedgerSink = new InMemorySink()) {}
  append(input: SinkAppendInput): void {
    this.calls++;
    if (this.calls % this.failEvery === 0) throw new Error("simulated durable-append failure");
    this.inner.append(input);
  }
}
