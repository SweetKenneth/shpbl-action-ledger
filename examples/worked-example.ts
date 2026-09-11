/**
 * Worked example from SPEC §9: propose, decline, execute an alternative, then show a
 * tampering attempt on the stored export being caught by the independent verifier.
 */
import { Ledger } from "../src/ledger.js";
import { verifyLedger } from "../src/verify.js";

async function main() {
  const ledger = new Ledger();

  await ledger.recordAction({
    kind: "proposal",
    actor: "agent-1",
    action: "file.write",
    subject: "/etc/hosts",
    occurredAt: new Date().toISOString(),
  });

  await ledger.recordAction({
    kind: "annotation",
    actor: "human-reviewer",
    action: "policy.decline",
    occurredAt: new Date().toISOString(),
  });

  await ledger.recordAction({
    kind: "execution",
    actor: "agent-1",
    action: "file.write",
    subject: "/tmp/hosts.draft",
    outcome: "success",
    occurredAt: new Date().toISOString(),
  });

  const exported = ledger.exportLedger() as any;
  console.log("export headDigest:", exported.headDigest);

  const clean = verifyLedger(exported);
  console.log("clean export verifies:", clean.valid);

  // Simulate an operator tampering with the stored export: sequence 1's action is edited.
  const tampered = JSON.parse(JSON.stringify(exported));
  tampered.entries[1].action = "policy.approve";

  const tamperedResult = verifyLedger(tampered);
  console.log("tampered export verifies:", tamperedResult.valid, tamperedResult.failure);
}

main();
