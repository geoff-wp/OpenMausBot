import { z } from "zod";
import { OutcomeError, type OutcomeActor, type OutcomeService } from "../outcomes.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface OutcomeRouteDeps {
  service: OutcomeService;
  /** Per-turn bearer identity resolved by the harness; body ids grant nothing. */
  actor(header: string | string[] | undefined): OutcomeActor | null;
  verifierIdentity(auth: Parameters<RouteHandler>[0]["auth"]): string;
  history(outcomeId: string, beforeVersion?: number): unknown[];
}
const action = z.object({ expectedVersion: z.number().int().min(1), target: z.unknown().optional() }).strict();
const consumption = z.object({ attemptId: z.string().min(1).max(128), resultId: z.string().min(1).max(128) }).strict();

export function createOutcomeRoutes(deps: OutcomeRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const internal = path.match(/^\/api\/internal\/outcomes(?:\/([\w-]+)(?:\/(publish|consume|verify))?)?$/);
    const external = path.match(/^\/api\/outcomes(?:\/([\w-]+)(?:\/(advance|cancel|retry|verification|verify|history))?)?$/);
    if (!internal && !external) return PASS;
    const actor = internal ? deps.actor(req.headers.authorization) : null;
    if (internal && !actor) return json(res, 401, { error: "This outcome operation needs its live bot-task capability" });
    if (external && deps.actor(req.headers.authorization)) return json(res, 403, { error: "A bot capability cannot register requirements or mint trusted verification" });
    // Trusted verification and registration are deliberately absent from the
    // native catalog and require an independently authenticated operator.
    if (external && !auth.scopes.includes("admin")) return json(res, 403, { error: "Outcome definitions and verification receipts require administrator scope" });
    try {
      if (internal) {
        if (method === "GET" && !internal[1]) return json(res, 200, { outcomes: deps.service.listForActor(actor!) });
        const outcomeId = internal[1]!;
        if (method === "GET" && !internal[2]) return json(res, 200, { outcome: deps.service.get(outcomeId, actor!) });
        if (method !== "POST") return json(res, 405, { error: "method_not_allowed" });
        const body = await readBody(req);
        let outcome;
        if (internal[2] === "publish") outcome = deps.service.publish(outcomeId, body, actor!);
        else if (internal[2] === "consume") { const input = consumption.parse(body); outcome = deps.service.consume(outcomeId, input.attemptId, input.resultId, actor!); }
        else if (internal[2] === "verify") { if (!body || Object.keys(body).length) throw new OutcomeError("verify takes an empty object", 400); outcome = await deps.service.verify(outcomeId, actor!); }
        else return json(res, 404, { error: "not_found" });
        void deps.service.drain().catch(() => {});
        if (internal[2] === "publish") void deps.service.verify(outcomeId, actor!).catch(() => {});
        return json(res, 200, { accepted: true, outcome, verified: outcome.state === "verified_success" });
      }
      if (method === "GET") {
        if (external![2] === "history") { const before = Number(new URL(req.url!, "http://localhost").searchParams.get("before")); return json(res, 200, { events: deps.history(external![1]!, Number.isSafeInteger(before) && before > 0 ? before : undefined) }); }
        if (external![1]) return json(res, 200, { outcome: deps.service.get(external![1]!) });
        return json(res, 200, { outcomes: deps.service.list() });
      }
      if (method !== "POST") return json(res, 405, { error: "method_not_allowed" });
      const body = await readBody(req);
      if (!external![1]) return json(res, 201, { outcome: deps.service.register(body) });
      const outcomeId = external![1]!;
      let outcome;
      if (external![2] === "verification") outcome = deps.service.recordVerification(outcomeId, body, deps.verifierIdentity(auth));
      else if (external![2] === "verify") { if (!body || Object.keys(body).length) throw new OutcomeError("verify takes an empty object", 400); outcome = await deps.service.verify(outcomeId); }
      else {
        const input = action.parse(body);
        if (external![2] === "advance") outcome = deps.service.advance(outcomeId, input.expectedVersion, input.target);
        else if (external![2] === "cancel") outcome = deps.service.cancel(outcomeId, input.expectedVersion);
        else if (external![2] === "retry") outcome = deps.service.retryDelivery(outcomeId, input.expectedVersion);
        else return json(res, 404, { error: "not_found" });
      }
      void deps.service.drain().catch(() => {});
      return json(res, 200, { outcome, verified: outcome.state === "verified_success" });
    } catch (error) {
      if (error instanceof z.ZodError) return json(res, 400, { error: "Outcome validation failed", code: "invalid_outcome_input", fields: error.issues.map(issue => ({ field: issue.path.join("."), message: issue.message })) });
      const failure = error as { status?: number; code?: string; message?: string };
      return json(res, failure.status ?? 500, { error: failure.status ? failure.message : "Outcome operation could not be confirmed; read its current receipt before retrying", ...(failure.code ? { code: failure.code } : {}) });
    }
  };
}
