import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusActivityRow } from "./StatusActivityRow";
import { groupTranscript, statusActivity } from "@/lib/activity-runs";
import type { Message } from "@/state/store";

describe("trusted operational state in chat", () => {
  const state: Message = { id: "host-state", role: "bot", kind: "activity", at: 1,
    tool: { name: "outcome: Operational task remains awaiting verification. Owner: Implementer. Next: check the actual deployed output.", ok: true },
    outcome: { id: "declared-work", attemptId: "current-attempt", kind: "task", label: "Actual workflow", state: "awaiting_verification", owner: { botId: "implementer", threadId: "canonical-task" }, version: 2 },
  };
  it("shows the host's current state, owner and next step without presenting the model's claim as proof", () => {
    const html = renderToStaticMarkup(createElement(StatusActivityRow, { message: state }));
    expect(html).toContain('role="status"');
    expect(html).toContain('data-outcome-state="awaiting_verification"');
    expect(html).toContain("Owner: Implementer");
    expect(html).toContain("actual deployed output");
  });
  it("does not accept a lookalike tool-name prefix as trusted outcome data", () => {
    expect(statusActivity({ ...state, outcome: undefined })).toBeNull();
    expect(renderToStaticMarkup(createElement(StatusActivityRow, { message: { ...state, outcome: undefined } }))).toBe("");
  });
  it("keeps outcome facts as a separate visible row rather than folding them into tool runs", () => {
    const step = (id: string): Message => ({ id, role: "bot", kind: "activity", at: 1, tool: { name: "Read", ok: true } });
    const grouped = groupTranscript([step("a"), step("b"), state, step("c"), step("d")]);
    expect(grouped.map(row => row.kind)).toEqual(["run", "message", "run"]);
    expect(grouped[1]).toEqual({ kind: "message", message: state });
  });
});
