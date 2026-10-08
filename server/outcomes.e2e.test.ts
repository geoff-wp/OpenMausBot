import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { callTool, toolCallContextFromEnv } from "./drivers/agents-call.ts";

describe("operational outcomes through the actual isolated server", () => {
  let fixture: VerificationServer;
  let evidence: unknown[];
  const api = async (method: string, path: string, body?: unknown, token?: string, expected = 200) => {
    const response = await fetch(fixture.info.url + path, { method,
      headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : { origin: fixture.info.url }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, method + " " + path + ": " + JSON.stringify(result)).toBe(expected);
    evidence.push({ method, path, status: response.status, ...(path.includes("outcomes") ? { result } : {}) });
    return result;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  const bot = async (name: string) => {
    const created = await control(["new-bot", "--name", name]) as any;
    const row = (await api("GET", "/api/bots?messages=0")).bots.find((value: any) => value.id === created.bot.id);
    return { botId: row.id, threadId: row.tasks[0].threadId };
  };
  const dump = async (threadId: string) => {
    let value: any;
    await expect.poll(() => { try { value = JSON.parse(readFileSync(join(fixture.info.dataDir, threadId + ".json"), "utf8")); return true; } catch { return false; } }, { timeout: 15_000 }).toBe(true);
    return value;
  };
  const messages = async (threadId: string) => (await api("GET", "/api/threads/" + threadId + "/messages?limit=100")).messages as any[];
  beforeEach(async () => {
    fixture = await launchVerificationServer(); evidence = [{ fixture: { url: fixture.info.url, logPath: fixture.info.logPath } }];
    const wrapper = join(fixture.info.dataDir, "outcome-gated.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node", 'import { readFileSync } from "node:fs";', 'import { join } from "node:path";',
      'const at = process.argv.indexOf("--mcp-config");',
      'const thread = at < 0 ? "probe" : JSON.parse(readFileSync(process.argv[at + 1], "utf8")).mcpServers?.agents?.env?.OMB_THREAD_ID ?? "probe";',
      'process.env.FAKE_CLAUDE_MODE = "slow";',
      'process.env.FAKE_CLAUDE_TOOL_CALLS = JSON.stringify([{ name:"Read", input:{file_path:"affected.ts"}, ok:true }]);',
      'process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = join(' + JSON.stringify(fixture.info.dataDir) + ',thread+".gate");',
      'process.env.FAKE_CLAUDE_DUMP = join(' + JSON.stringify(fixture.info.dataDir) + ',thread+".json");',
      'await import(' + JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href) + ');',
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
  }, 30_000);
  afterEach(async () => {
    if (!fixture) return;
    writeFileSync(fixture.info.logPath + ".outcomes.json", JSON.stringify({ evidence }, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath: fixture.info.logPath + ".outcomes.json" }));
    await fixture.close();
  });

  it("delivers while the producer is still active and records actual pickup without a magic phrase", async () => {
    const producer = await bot("Outcome producer"); const recipient = await bot("Outcome recipient");
    const registered = (await api("POST", "/api/outcomes", { id: "real-handoff", kind: "handoff", label: "Return an actual result", producer, recipient,
      target: { revision: "candidate-1", environment: "isolated" }, checks: [], firstWork: { tool: "Read", inputIncludes: "affected.ts" }, progressWarningMs: 1_000,
    }, undefined, 201)).outcome;
    await control(["send", "--bot", producer.botId, "--task", producer.threadId, "--text", "Produce the registered result and remain at the fixture gate."]);
    const launched = await dump(producer.threadId);
    expect(launched.mcpConfig.mcpServers.agents.env.OMB_OUTCOMES_ENABLED).toBe("1");
    expect(launched.systemPrompt).toContain("Registered operational requirements");
    expect(launched.systemPrompt).toContain(registered.id);
    expect(launched.systemPrompt).toContain(registered.attemptId);
    const context = toolCallContextFromEnv(launched.mcpConfig.mcpServers.agents.env);
    const publication = await callTool("publish_result", { outcome_id: registered.id, attempt_id: registered.attemptId, result_id: "real-result", revision: "candidate-1", environment: "isolated", verdict: "FAIL", summary: "A scoped defect needs repair", evidence_json: JSON.stringify({ actual: "failed", case: "required-case", count: 1 }) }, context);
    expect(publication.isError).not.toBe(true);
    await expect.poll(async () => (await api("GET", "/api/outcomes/real-handoff")).outcome.delivery?.state, { timeout: 20_000 }).toBe("delivered");
    await expect.poll(async () => (await api("GET", "/api/outcomes/real-handoff")).outcome.firstWorkObserved?.tool, { timeout: 20_000 }).toBe("Read");
    const value = (await api("GET", "/api/outcomes/real-handoff")).outcome;
    expect(value.owner).toEqual(recipient);
    expect(value.state).toBe("verified_success");
    const roster = (await api("GET", "/api/bots?messages=0")).bots;
    expect(roster.find((row: any) => row.id === producer.botId).tasks.find((row: any) => row.threadId === producer.threadId).busy).toBe(true);
    const received = await messages(recipient.threadId);
    expect(received.filter(row => row.sendId === value.delivery.sendId)).toHaveLength(1);
    expect(received.some(row => row.role === "bot" && row.text?.includes("QA_RESULT_ACCEPTED"))).toBe(false);
    await callTool("publish_result", { outcome_id: registered.id, attempt_id: registered.attemptId, result_id: "real-result", revision: "candidate-1", environment: "isolated", verdict: "FAIL", summary: "A scoped defect needs repair", evidence_json: JSON.stringify({ count: 1, case: "required-case", actual: "failed" }) }, context);
    expect((await messages(recipient.threadId)).filter(row => row.sendId === value.delivery.sendId)).toHaveLength(1);
    evidence.push({ preservedEvidence: JSON.parse(value.result.evidence), owner: value.owner, actualPickup: value.firstWorkObserved, producerRemainedActive: true });
  }, 60_000);

  it("does not trust a claimed PASS, wrong live output, or native attempts to mint check receipts", async () => {
    const producer = await bot("Claiming producer");
    const content = "actual expected output";
    const registered = (await api("POST", "/api/outcomes", { id: "real-task", kind: "task", label: "Create the required artifact", producer,
      target: { revision: "artifact-1", environment: "isolated" }, checks: [{ id: "actual-artifact", kind: "artifact", description: "Expected bytes in the actual task folder", path: "required.txt", sha256: createHash("sha256").update(content).digest("hex"), maxAgeMs: 60_000 }],
    }, undefined, 201)).outcome;
    await control(["send", "--bot", producer.botId, "--task", producer.threadId, "--text", "Create the artifact required by the registered outcome."]);
    const launched = await dump(producer.threadId);
    const context = toolCallContextFromEnv(launched.mcpConfig.mcpServers.agents.env);
    const publication = await callTool("publish_result", { outcome_id: registered.id, attempt_id: registered.attemptId, result_id: "claimed-result", revision: "artifact-1", environment: "isolated", verdict: "PASS", summary: "The model claims done", evidence_json: "Claimed completion" }, context);
    expect(publication.isError).not.toBe(true);
    await expect.poll(async () => (await api("GET", "/api/outcomes/real-task")).outcome.state, { timeout: 15_000 }).toBe("verified_failure");
    await api("POST", "/api/outcomes/real-task/verification", { attemptId: registered.attemptId, target: registered.target, checkId: "actual-artifact", receiptId: "fake", checkedAt: Date.now(), status: "pass", evidence: "A model promise" }, context.client === undefined ? "" : launched.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN, 403);
    writeFileSync(join(fixture.info.dataDir, producer.threadId + ".gate"), "finish the fake provider's turn");
    await control(["wait", "--bot", producer.botId, "--task", producer.threadId]);
    expect((await api("GET", "/api/outcomes/real-task")).outcome.state).toBe("verified_failure");
    expect((await messages(producer.threadId)).some(row => row.tool?.name?.includes("Host outcome remains verified_failure"))).toBe(true);
    const peer = await bot("Closure peer");
    await api("PATCH", "/api/bots/" + producer.botId, { peers: [peer.botId] });
    const sibling = (await api("POST", "/api/bots/" + producer.botId + "/tasks", { title: "Review the registered result" }, undefined, 201)).task;
    await control(["send", "--bot", producer.botId, "--task", sibling.threadId, "--text", "Review the other task's requested output."]);
    const caller = await dump(sibling.threadId);
    const token = caller.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    const refusal = await api("POST", "/api/internal/threads/" + producer.threadId + "/close", {}, token, 409);
    expect(refusal.code).toBe("outcome_not_verified");
    mkdirSync(launched.cwd, { recursive: true }); writeFileSync(join(launched.cwd, "required.txt"), content);
    const checked = (await api("POST", "/api/outcomes/real-task/verify", {})).outcome;
    expect(checked.state).toBe("verified_success");
    const closed = await api("POST", "/api/internal/threads/" + producer.threadId + "/close", {}, token);
    expect(closed.closed).toBe(true);
    const history = (await api("GET", "/api/outcomes/real-task/history")).events;
    expect(history.some((row: any) => row.state === "verified_failure")).toBe(true);
    evidence.push({ actualCreatedArtifactChecked: true, requiredSha256: registered.checks[0].sha256, priorFailureRetained: true });
  }, 60_000);
});
