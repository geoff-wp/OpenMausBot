import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb, readWorkOutcome, saveWorkOutcome, workOutcomes, workOutcomeHistory, withCommandReceipt } from "./message-db.ts";
import { OutcomeService } from "./outcomes.ts";

describe("outcomes in the existing transcript database", () => {
  beforeEach(() => { closeMessageDb(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
  const service = () => new OutcomeService({ persistence: { get: readWorkOutcome, list: workOutcomes, save: saveWorkOutcome }, exists: () => true, binding: () => "same-resource", request: () => null, deliver: async () => ({ messageId: "actual-receipt" }), probe: async () => ({ status: "unavailable", evidence: "No configured checker result" }) });
  const register = (value: OutcomeService) => value.register({ id: "durable", kind: "task", label: "Durable operational work", producer: { botId: "producer", threadId: "canonical" }, target: { revision: "candidate", environment: "actual" }, checks: [{ id: "required", kind: "attestation", description: "Required evidence", maxAgeMs: 60_000 }] });
  it("retains the exact attempt, checks and all earlier receipts across a database reopen", () => {
    const api = service(); const initial = register(api);
    api.publish(initial.id, { attemptId: initial.attemptId, resultId: "publication", target: initial.target, verdict: "PASS", summary: "Claimed", evidence: { source: "actual" } }, { ...initial.producer, generation: "generation" });
    const before = api.get(initial.id); closeMessageDb();
    const restored = service().get(initial.id);
    expect(restored).toEqual(before);
    expect(restored.state).toBe("awaiting_verification");
    expect(workOutcomeHistory(initial.id).map(value => value.version)).toEqual([2, 1]);
  });
  it("rejects an old operator version instead of overwriting a newer state", () => {
    const api = service(); const first = register(api);
    api.cancel(first.id, first.version);
    expect(() => saveWorkOutcome({ ...first, version: 2 }, first.version)).toThrow(/changed/);
    expect(readWorkOutcome(first.id)?.state).toBe("cancelled");
  });
  it("rolls back outcome rows and history with their enclosing atomic command", () => {
    const api = service();
    expect(() => withCommandReceipt("test", "rollback", () => { register(api); throw new Error("discard the synthetic command"); }, Date.now())).toThrow(/discard/);
    expect(readWorkOutcome("durable")).toBeNull();
    expect(workOutcomeHistory("durable")).toEqual([]);
  });
});
