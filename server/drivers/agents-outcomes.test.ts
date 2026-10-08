import { describe, expect, it } from "vitest";
import { availableTools, catalogProfileFromEnv } from "./agents-catalog.ts";
import { callTool, type ToolCallContext } from "./agents-call.ts";

describe("provider-neutral outcome tools", () => {
  it("mounts only result lifecycle tools in a one-hop delegate, not peer or privileged control", () => {
    const profile = catalogProfileFromEnv({ OMB_OUTCOMES_ENABLED: "1", OMB_OUTCOMES_ONLY: "1", OMB_CHIEF_OF_STAFF: "1", OMB_SKILL_AUTHORING_ENABLED: "1" });
    expect(availableTools(profile).map(tool => tool.name)).toEqual(["get_outcome", "publish_result", "consume_result", "verify_outcome"]);
  });
  it("does not add task tools or token overhead to unregistered ordinary chats", () => {
    expect(availableTools(catalogProfileFromEnv({})).some(tool => tool.name === "publish_result")).toBe(false);
    const registered = availableTools(catalogProfileFromEnv({ OMB_OUTCOMES_ENABLED: "1" }));
    expect(registered.some(tool => tool.name === "publish_result")).toBe(true);
    for (const tool of registered.filter(tool => ["get_outcome", "publish_result", "consume_result", "verify_outcome"].includes(tool.name))) {
      const wire = JSON.stringify(tool.inputSchema);
      expect(wire).not.toMatch(/oneOf|\$ref|\$defs/);
    }
  });
  it("forwards evidence and exact target fields, and preserves actionable server refusals", async () => {
    let request: { path: string; body: unknown } | undefined;
    const context: ToolCallContext = { botId: "producer", threadId: "canonical", depth: 0, externalRuntime: false, coordinating: false, sharedComputers: false,
      client: { api: async () => ({}), apiResponse: async (path, init) => { request = { path, body: JSON.parse(String(init?.body)) }; return { ok: false, status: 409, body: { error: "Wrong actual revision", code: "stale_outcome_target" } }; } },
    };
    const evidence = { actual: "missing", case: "required" };
    const response = await callTool("publish_result", { outcome_id: "registered", attempt_id: "current", result_id: "publication", revision: "candidate", environment: "real-target", configuration: "exact-config", verdict: "FAIL", summary: "A concrete requirement failed", evidence_json: JSON.stringify(evidence) }, context);
    expect(response.isError).toBe(true);
    expect(response.text).toContain("stale_outcome_target");
    expect(request).toEqual({ path: "/api/internal/outcomes/registered/publish", body: { attemptId: "current", resultId: "publication", target: { revision: "candidate", environment: "real-target", configuration: "exact-config" }, verdict: "FAIL", summary: "A concrete requirement failed", evidence } });
  });
});
