import { beforeEach, describe, expect, it } from "vitest";
import { normalizeOutcomeEvidence, OutcomeError, OutcomeService, outcomeInstructions } from "./outcomes.ts";
import type { OutcomeDefinition, WorkOutcome } from "../shared/outcomes.ts";

describe("host-owned operational outcomes", () => {
  const producer = { botId: "producer", threadId: "producing-task", generation: "producer-generation" };
  const recipient = { botId: "recipient", threadId: "receiving-task", generation: "recipient-generation" };
  let clock: number;
  let binding: string;
  let records: Map<string, WorkOutcome>;
  let delivery: Map<string, string>;
  let effects: number;
  let lostResponse: boolean;
  let consumeBeforeLostResponse: boolean;
  let busy: boolean;
  let requestOwnsResult: boolean;
  let probe: "pass" | "fail" | "pending" | "unavailable" | null;
  let service: OutcomeService;
  let routineRunId: string | undefined;
  const definition = (changes: Partial<OutcomeDefinition> = {}): OutcomeDefinition => {
    const value = { id: "operational-work", kind: "task" as const, label: "Required workflow", producer,
      target: { revision: "candidate-1", environment: "registered-environment", configuration: "config-1" },
      checks: [{ id: "required-check", kind: "attestation" as const, description: "Independently verified acceptance", maxAgeMs: 5_000 }],
      progressWarningMs: 1_000, ...changes };
    return { ...value, producer: { botId: value.producer.botId, threadId: value.producer.threadId },
      ...(value.recipient ? { recipient: { botId: value.recipient.botId, threadId: value.recipient.threadId } } : {}) };
  };
  const publish = (changes: Record<string, unknown> = {}) => {
    const value = service.get("operational-work");
    return service.publish(value.id, { attemptId: value.attemptId, resultId: "result-1", target: value.target, verdict: "PASS", summary: "The model says it finished", evidence: { cases: 12, passed: true }, ...changes }, producer);
  };
  const verify = (status: "pass" | "fail" | "pending" | "unavailable", receiptId = "check-receipt") => {
    const value = service.get("operational-work");
    return service.recordVerification(value.id, { attemptId: value.attemptId, target: value.target, checkId: "required-check", receiptId, checkedAt: clock, status, evidence: "Actual independently observed postcondition" }, "trusted-checker");
  };
  beforeEach(() => {
    clock = 10_000; binding = "registered-resource"; records = new Map(); delivery = new Map(); effects = 0; routineRunId = undefined;
    lostResponse = false; consumeBeforeLostResponse = false; busy = false; requestOwnsResult = true; probe = "pass";
    service = new OutcomeService({
      now: () => clock, exists: () => true, binding: () => binding,
      routineRunId: () => routineRunId,
      persistence: {
        get: id => records.has(id) ? structuredClone(records.get(id)!) : null,
        list: threadId => [...records.values()].filter(value => !threadId || value.producer.threadId === threadId || value.recipient?.threadId === threadId).map(value => structuredClone(value)),
        save: (value, expected) => { expect(records.get(value.id)?.version ?? null).toBe(expected); records.set(value.id, structuredClone(value)); },
      },
      request: value => value.delivery && delivery.has(value.delivery.sendId) && requestOwnsResult ? { messageId: delivery.get(value.delivery.sendId)!, generation: recipient.generation, turnId: "receiving-turn", phase: "working" } : null,
      deliver: async value => {
        if (busy) throw new OutcomeError("Exact receiving task busy", 409, "guarded_busy");
        if (!delivery.has(value.delivery!.sendId)) { effects++; delivery.set(value.delivery!.sendId, "receiving-message"); }
        if (lostResponse) {
          lostResponse = false;
          if (consumeBeforeLostResponse) service.consume(value.id, value.attemptId, value.result!.id, recipient);
          throw new Error("Response lost after actual persistence");
        }
        return { messageId: delivery.get(value.delivery!.sendId)! };
      },
      probe: async () => probe === null ? null as never : { status: probe, evidence: "Host checked the actual registered resource" },
    });
  });

  it("cannot turn model PASS, missing checks or a ceremonial acknowledgment into verified completion", () => {
    service.register(definition());
    expect(publish().state).toBe("awaiting_verification");
    expect(service.closeRefusal(producer.threadId)).toContain("not verified complete");
    expect(verify("pending").state).toBe("awaiting_verification");
    expect(verify("pass", "real-pass").state).toBe("verified_success");
    expect(service.closeRefusal(producer.threadId)).toBeNull();
  });

  it("preserves deterministic failure when a subsequent checker is unavailable", () => {
    service.register(definition()); publish();
    expect(verify("fail").state).toBe("verified_failure");
    clock++;
    expect(verify("unavailable", "unavailable-checker").state).toBe("verified_failure");
    clock++;
    expect(verify("pass", "actual-correction").state).toBe("verified_success");
  });

  it("cannot convert an absent/null host checker into success", async () => {
    service.register(definition({ checks: [{ id: "file", kind: "artifact", path: "required.txt", sha256: "a".repeat(64), description: "Actual artifact", maxAgeMs: 5_000 }] })); publish(); probe = null;
    const value = await service.verify("operational-work");
    expect(value.state).toBe("needs_setup");
    expect(value.verification[0].status).toBe("unavailable");
  });

  it("binds every publication and check to the exact attempt, environment, revision and configuration", () => {
    const value = service.register(definition());
    for (const field of ["revision", "environment", "configuration"]) {
      expect(() => publish({ target: { ...value.target, [field]: "wrong" } })).toThrow(/does not match/);
    }
    expect(records.get(value.id)?.result).toBeUndefined();
    publish(); verify("pass");
    const advanced = service.advance(value.id, service.get(value.id).version, { ...value.target, revision: "candidate-2" });
    expect(advanced.state).toBe("incomplete");
    expect(advanced.verification).toEqual([]);
    expect(advanced.history[0].result?.id).toBe("result-1");
    expect(() => service.recordVerification(value.id, { attemptId: value.attemptId, target: value.target, checkId: "required-check", receiptId: "late-old-pass", checkedAt: clock, status: "pass", evidence: "old check" }, "trusted-checker")).toThrow(/superseded/);
  });

  it("rejects another actor and an outcome whose actual resource changed", () => {
    const value = service.register(definition());
    expect(() => service.get(value.id, { botId: "outsider", threadId: "other-task" })).toThrow(/other bot tasks/);
    expect(() => service.publish(value.id, { attemptId: value.attemptId, resultId: "result-1", target: value.target, verdict: "PASS", summary: "wrong actor", evidence: "claimed" }, recipient)).toThrow(/producing task/);
    binding = "different-working-folder";
    expect(() => publish()).toThrow(/resource or working folder changed/);
    expect(service.get(value.id).state).toBe("needs_setup");
  });

  it("publishes losslessly, immediately and idempotently while the producer is still working", async () => {
    service.register(definition({ kind: "handoff", recipient, checks: [], firstWork: { tool: "Read", inputIncludes: "affected.ts" } }));
    const evidence = { sandbox: "actual-resource", observed: [{ case: "required", actual: "failed", count: 0 }] };
    const first = publish({ verdict: "FAIL", evidence });
    expect(JSON.parse(first.result!.evidence)).toEqual(evidence);
    expect(publish({ verdict: "FAIL", evidence }).version).toBe(first.version);
    await service.drain(); await service.drain();
    expect(effects).toBe(1);
    expect(service.get(first.id).delivery?.state).toBe("delivered");
  });

  it("reconciles a lost send response with the same identity and does not duplicate the effect", async () => {
    service.register(definition({ kind: "handoff", recipient, checks: [], firstWork: { tool: "Read" } }));
    publish(); lostResponse = true;
    await service.drain();
    const waiting = service.get("operational-work");
    expect(waiting.delivery?.state).toBe("pending");
    expect(effects).toBe(1);
    clock = waiting.delivery!.retryAt;
    await service.drain();
    expect(service.get(waiting.id).delivery?.state).toBe("delivered");
    expect(effects).toBe(1);
  });

  it("keeps sender ownership after consumption alone and transfers only on matching real first work", async () => {
    service.register(definition({ kind: "handoff", recipient, checks: [], firstWork: { tool: "Read", inputIncludes: "affected.ts" } }));
    publish(); await service.drain();
    const value = service.get("operational-work");
    const consumed = service.consume(value.id, value.attemptId, value.result!.id, recipient);
    expect(consumed.owner.botId).toBe(producer.botId);
    service.observe({ type: "item.started", itemType: "tool", threadId: recipient.threadId, turnId: "receiving-turn", itemId: "bookkeeping", title: "get_outcome", input: "affected.ts" }, recipient.generation);
    service.observe({ type: "item.completed", itemType: "tool", threadId: recipient.threadId, turnId: "receiving-turn", itemId: "bookkeeping", ok: true }, recipient.generation);
    expect(service.get(value.id).firstWorkObserved).toBeUndefined();
    service.observe({ type: "item.started", itemType: "tool", threadId: recipient.threadId, turnId: "receiving-turn", itemId: "actual-work", title: "Read", input: "affected.ts" }, recipient.generation);
    service.observe({ type: "item.completed", itemType: "tool", threadId: recipient.threadId, turnId: "receiving-turn", itemId: "actual-work", ok: true }, recipient.generation);
    expect(service.get(value.id).owner.botId).toBe(recipient.botId);
    expect(service.get(value.id).state).toBe("verified_success");
  });
  it("does not downgrade an independently confirmed delivery after its original send response is lost", async () => {
    service.register(definition({ kind: "handoff", recipient, checks: [], firstWork: { tool: "Read" } }));
    publish(); lostResponse = true; consumeBeforeLostResponse = true;
    await service.drain();
    const value = service.get("operational-work");
    expect(value.delivery?.state).toBe("delivered");
    expect(value.delivery?.error).toBeUndefined();
    expect(value.consumption?.messageId).toBe("receiving-message");
    await service.drain(); expect(effects).toBe(1);
  });

  it("informs enrolled turns of their exact native contract without promoting result prose to system instructions", () => {
    service.register(definition());
    publish({ summary: "UNTRUSTED_SUMMARY", evidence: "UNTRUSTED_EVIDENCE" });
    const value = service.get("operational-work");
    const text = outcomeInstructions([value], producer.threadId);
    expect(text).toContain(value.id); expect(text).toContain(value.attemptId);
    expect(text).toContain('"role":"producer"'); expect(text).toContain("publish_result");
    expect(text).not.toContain("UNTRUSTED_SUMMARY"); expect(text).not.toContain("UNTRUSTED_EVIDENCE");
    expect(outcomeInstructions([{ ...value, state: "cancelled" }], producer.threadId)).toBe("");
    const handoff = { ...value, recipient };
    expect(outcomeInstructions([handoff], recipient.threadId)).toContain('"role":"recipient"');
  });

  it("binds required proof to its actual routine run and does not inherit prior checks on a reused conversation", () => {
    routineRunId = "first-run";
    const prior = service.register(definition()); publish(); verify("fail");
    expect(service.listForRoutine(producer.threadId, "first-run")).toHaveLength(1);
    routineRunId = "second-run";
    expect(service.listForRoutine(producer.threadId, "second-run")).toEqual([]);
    expect(() => service.register(definition())).toThrow(/earlier routine run/);
    expect(service.listForActor(producer)).toEqual([]);
    expect(() => service.get(prior.id, producer)).toThrow(/earlier routine run/);
    const next = service.register(definition({ id: "second-outcome" }));
    expect(service.listForRoutine(producer.threadId, "second-run").map(value => value.id)).toEqual([next.id]);
    expect(service.listForRoutine(producer.threadId, "first-run")[0].state).toBe("verified_failure");
    service.advance(prior.id, service.get(prior.id).version, { ...prior.target, revision: "next-revision" });
    expect(service.listForRoutine(producer.threadId, "first-run")).toEqual([]);
    expect(service.listForRoutine(producer.threadId, "second-run")).toHaveLength(2);
  });

  it("provides retrieval of every requirement when the system preview is bounded", () => {
    for (let i = 0; i < 21; i++) service.register(definition({ id: "requirement-" + i }));
    const records = service.listForActor(producer);
    expect(records).toHaveLength(21);
    expect(records[20].id).toBe("requirement-20");
    const prompt = outcomeInstructions(records, producer.threadId);
    expect(prompt).toContain("20 of 21 requirements");
    expect(prompt).toContain("get_outcome with no outcome_id");
  });

  it("does not poll terminal checks or create new receipt versions for unchanged current proof", async () => {
    service.register(definition({ checks: [{ id: "file", kind: "artifact", path: "required.txt", sha256: "a".repeat(64), description: "Actual artifact", maxAgeMs: 5_000 }] }));
    publish(); await service.verify("operational-work");
    const verified = service.get("operational-work");
    expect(verified.state).toBe("verified_success");
    clock += 1_000; await service.verify(verified.id);
    expect(service.get(verified.id).version).toBe(verified.version);
    clock += 5_001; await service.tick();
    expect(records.get(verified.id)?.version).toBe(verified.version);
    // A deliberate re-check still refreshes genuinely expired evidence.
    await service.verify(verified.id);
    expect(service.get(verified.id).state).toBe("verified_success");
    expect(service.get(verified.id).version).toBeGreaterThan(verified.version);
  });

  it("recognizes real request-scoped work without requiring an acknowledgment phrase or ceremony", async () => {
    service.register(definition({ kind: "handoff", recipient, checks: [], firstWork: { tool: "Read", inputIncludes: "affected.ts" } }));
    publish(); await service.drain();
    for (const generation of ["wrong-generation", recipient.generation]) {
      service.observe({ type: "item.started", itemType: "tool", threadId: recipient.threadId, turnId: "receiving-turn", itemId: "work-" + generation, title: "Read", input: "affected.ts" }, generation);
      service.observe({ type: "item.completed", itemType: "tool", threadId: recipient.threadId, turnId: "receiving-turn", itemId: "work-" + generation, ok: true }, generation);
      expect(Boolean(service.get("operational-work").firstWorkObserved)).toBe(generation === recipient.generation);
    }
    expect(service.get("operational-work").consumption?.messageId).toBe("receiving-message");
  });

  it("does not count work from a newer user request as pickup of the old result", async () => {
    service.register(definition({ kind: "handoff", recipient, checks: [], firstWork: { tool: "Read" } })); publish(); await service.drain(); requestOwnsResult = false;
    const value = service.get("operational-work");
    expect(() => service.consume(value.id, value.attemptId, value.result!.id, recipient)).toThrow(/does not own/);
    service.observe({ type: "item.started", itemType: "tool", threadId: recipient.threadId, turnId: "receiving-turn", itemId: "other-request-work", title: "Read" }, recipient.generation);
    service.observe({ type: "item.completed", itemType: "tool", threadId: recipient.threadId, turnId: "receiving-turn", itemId: "other-request-work", ok: true }, recipient.generation);
    expect(service.get(value.id).firstWorkObserved).toBeUndefined();
  });

  it("keeps busy admission waits owned without exhausting a transient-error budget", async () => {
    service.register(definition({ kind: "handoff", recipient, checks: [], firstWork: { tool: "Read" } })); publish(); busy = true;
    for (let i = 0; i < 5; i++) { await service.drain(); clock += 5_001; }
    const waiting = service.get("operational-work");
    expect(waiting.delivery?.attempts).toBe(0);
    expect(waiting.waiting?.owner.botId).toBe(producer.botId);
    expect(waiting.waiting?.overdue).toBe(true);
    busy = false; await service.drain(); expect(effects).toBe(1);
  });

  it("does not refresh verification freshness when an old receipt is retried", () => {
    service.register(definition()); publish(); verify("pass");
    const at = service.get("operational-work").verification[0].at;
    clock += 4_000;
    const value = service.get("operational-work");
    service.recordVerification(value.id, { attemptId: value.attemptId, target: value.target, checkId: "required-check", receiptId: "check-receipt", checkedAt: at, status: "pass", evidence: "Actual independently observed postcondition" }, "trusted-checker");
    expect(service.get(value.id).verification[0].at).toBe(at);
    clock += 1_001;
    expect(service.get(value.id).state).toBe("awaiting_verification");
  });

  it("cancels the exact attempt and rejects late publication/check callbacks", () => {
    const value = service.register(definition());
    service.cancel(value.id, value.version);
    expect(() => publish()).toThrow(/cancelled/);
    expect(() => verify("pass")).toThrow(/cancelled/);
    expect(service.get(value.id).state).toBe("cancelled");
  });

  it("does not accept model-composed human-intervention claims as a host-observed card", () => {
    service.register(definition()); publish({ verdict: "HUMAN_INTERVENTION" });
    expect(service.get("operational-work").state).toBe("awaiting_verification");
    service.observe({ type: "request.opened", requestId: "real-permission", threadId: producer.threadId }, producer.generation);
    expect(service.get("operational-work").state).toBe("needs_human_action");
    service.observe({ type: "request.resolved", requestId: "real-permission", threadId: producer.threadId, behavior: "deny" }, producer.generation);
    expect(service.get("operational-work").deniedRequest?.requestId).toBe("real-permission");
  });

  it("rejects empty, oversized, circular and unsupported evidence without side effects", () => {
    service.register(definition());
    for (const evidence of [null, {}, [], " ", true, { empty: " " }, { huge: "a".repeat(20_001) }]) expect(() => publish({ evidence })).toThrow();
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => normalizeOutcomeEvidence(cycle)).toThrow(/JSON values/);
    expect(service.get("operational-work").result).toBeUndefined();
  });
});
