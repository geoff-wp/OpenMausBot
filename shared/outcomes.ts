/** Operational outcomes are independent of provider-turn settlement. */
export type OutcomeState = "incomplete" | "awaiting_verification" | "verified_success" | "verified_failure" | "needs_setup" | "needs_human_action" | "cancelled";
export type ResultVerdict = "PASS" | "FAIL" | "NOT_TESTED" | "NEEDS_SETUP" | "HUMAN_INTERVENTION";
export interface OutcomeParty { botId: string; threadId: string }
/** The trusted transcript projection omits policy paths and report bodies. */
export interface OutcomeSummary {
  id: string;
  attemptId: string;
  kind: "task" | "handoff";
  label: string;
  state: OutcomeState;
  owner: OutcomeParty;
  version: number;
}
export interface OutcomeTarget { revision: string; environment: string; configuration?: string }
export type OutcomeCheck =
  | { id: string; kind: "attestation"; description: string; maxAgeMs: number }
  | { id: string; kind: "artifact"; description: string; path: string; sha256: string; maxAgeMs: number }
  | { id: string; kind: "git_head"; description: string; maxAgeMs: number }
  | { id: string; kind: "github_pr"; description: string; maxAgeMs: number; repository: string; pullRequest: number; requiredChecks: string[] }
  | { id: string; kind: "http_json"; description: string; maxAgeMs: number; url: string; pointer: string; expectedValue?: string | number | boolean };
export interface OutcomeDefinition {
  id: string;
  kind: "task" | "handoff";
  label: string;
  producer: OutcomeParty;
  recipient?: OutcomeParty;
  /** Administrator-supplied ownership, validated against the actual active run.
   * Omitted associations mean ordinary work, even in a shared routine chat. */
  producerRoutineRunId?: string;
  recipientRoutineRunId?: string;
  target: OutcomeTarget;
  checks: OutcomeCheck[];
  /** A successful matching tool in the delivered request proves pickup. */
  firstWork?: { tool: string; inputIncludes?: string };
  progressWarningMs: number;
}
export interface OutcomeVerification {
  id: string;
  receiptId: string;
  status: "pass" | "fail" | "pending" | "unavailable";
  at: number;
  targetKey: string;
  source: "host_probe" | "trusted_verifier";
  verifier: string;
  evidence: string;
}
export interface OutcomeResult {
  id: string;
  digest: string;
  verdict: ResultVerdict;
  summary: string;
  evidence: string;
  at: number;
}
export interface OutcomeWait {
  owner: OutcomeParty;
  reason: string;
  nextAction: string;
  resumeTrigger: string;
  lastProgressAt: number;
  overdue: boolean;
}
export interface WorkOutcome extends OutcomeDefinition {
  version: number;
  attemptId: string;
  createdAt: number;
  updatedAt: number;
  progressAt: number;
  state: OutcomeState;
  owner: OutcomeParty;
  targetKey: string;
  resourceBinding: string;
  humanRequest?: { threadId: string; requestId: string; at: number };
  deniedRequest?: { threadId: string; requestId: string; at: number };
  result?: OutcomeResult;
  delivery?: {
    sendId: string;
    state: "pending" | "delivered" | "failed";
    messageId?: string;
    at?: number;
    attempts: number;
    retryAt: number;
    error?: string;
  };
  consumption?: { generation: string; messageId: string; at: number };
  firstWorkObserved?: { itemId: string; turnId: string; tool: string; at: number };
  verification: OutcomeVerification[];
  failures: OutcomeVerification[];
  waiting?: OutcomeWait;
  /** Prior attempts remain available for provenance; none unlock a new one. */
  history: Array<{ attemptId: string; target: OutcomeTarget; state: OutcomeState; result?: OutcomeResult; at: number }>;
}
