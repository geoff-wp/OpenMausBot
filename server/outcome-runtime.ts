import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { OutcomeActor } from "./outcomes.ts";
import { OutcomeService } from "./outcomes.ts";
import { readWorkOutcome, saveWorkOutcome, workOutcomes, workOutcomeHistory } from "./message-db.ts";
import { probeOutcome } from "./outcome-probes.ts";
import { createOutcomeRoutes } from "./routes/outcomes.ts";
import type { OutcomeParty, WorkOutcome } from "../shared/outcomes.ts";
import type { RequestAuth } from "./request-auth.ts";

export interface OutcomeRuntimeDeps {
  exists(party: OutcomeParty): boolean;
  workspace(party: OutcomeParty): { cwd: string; host: boolean; resource: string } | null;
  actor(header: IncomingMessage["headers"]["authorization"]): OutcomeActor | null;
  request(outcome: WorkOutcome): { messageId: string; generation: string | null; turnId: string | null; phase: string } | null;
  deliver(outcome: WorkOutcome, text: string): Promise<{ messageId: string }>;
  status(outcome: WorkOutcome): void;
  /** Existing routine bookkeeping can settle when required outcome proof arrives. */
  settled(threadId: string): void;
  pendingHumanRequest(threadId: string, requestId: string): boolean;
}

export function createOutcomeRuntime(deps: OutcomeRuntimeDeps) {
  const signatures = new Map<string, string>();
  const service = new OutcomeService({
    persistence: { get: readWorkOutcome, list: workOutcomes, save: saveWorkOutcome },
    exists: deps.exists,
    binding: party => createHash("sha256").update(JSON.stringify(deps.workspace(party))).digest("hex"),
    request: deps.request,
    deliver: deps.deliver,
    probe: (outcome, check) => probeOutcome(outcome, check, deps.workspace(outcome.producer)),
    pendingHumanRequest: deps.pendingHumanRequest,
    changed: outcome => {
      const signature = JSON.stringify([outcome.attemptId, outcome.state, outcome.owner, outcome.result?.id, outcome.delivery?.state, outcome.delivery?.error, Boolean(outcome.consumption), Boolean(outcome.firstWorkObserved), outcome.waiting?.reason, outcome.waiting?.overdue]);
      if (signatures.get(outcome.id) !== signature) { signatures.set(outcome.id, signature); deps.status(outcome); }
      deps.settled(outcome.producer.threadId);
      if (outcome.recipient) deps.settled(outcome.recipient.threadId);
    },
  });
  const routes = createOutcomeRoutes({
    service, actor: deps.actor,
    verifierIdentity: (auth: RequestAuth) => auth.kind === "session" ? "operator-session:" + auth.session.id : "local-workspace-owner",
    history: workOutcomeHistory,
  });
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await service.tick(); }
    catch { console.error("Operational outcome recovery could not be completed; pending receipts remain authoritative"); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 5_000);
  timer.unref();
  return { service, routes, tick, stop: () => clearInterval(timer) };
}
