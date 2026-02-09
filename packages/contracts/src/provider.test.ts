import { describe, expect, it } from "vitest";

import {
  providerEventSchema,
  providerRespondToRequestInputSchema,
  providerSendTurnInputSchema,
  providerSessionStartInputSchema,
} from "./provider";

describe("providerSessionStartInputSchema", () => {
  it("defaults to codex with safe policies", () => {
    const parsed = providerSessionStartInputSchema.parse({});
    expect(parsed.provider).toBe("codex");
    expect(parsed.approvalPolicy).toBe("never");
    expect(parsed.sandboxMode).toBe("workspace-write");
  });

  it("accepts optional resumeThreadId", () => {
    const parsed = providerSessionStartInputSchema.parse({
      resumeThreadId: "thread_123",
    });
    expect(parsed.resumeThreadId).toBe("thread_123");
  });

  it("rejects blank resumeThreadId", () => {
    expect(() =>
      providerSessionStartInputSchema.parse({
        resumeThreadId: "   ",
      }),
    ).toThrow();
  });
});

describe("providerSendTurnInputSchema", () => {
  it("trims input text and optional model/effort", () => {
    const parsed = providerSendTurnInputSchema.parse({
      sessionId: "sess_1",
      input: "  summarize this repo  ",
      model: "  gpt-5.2-codex  ",
      effort: "  high  ",
    });
    expect(parsed.input).toBe("summarize this repo");
    expect(parsed.model).toBe("gpt-5.2-codex");
    expect(parsed.effort).toBe("high");
  });
});

describe("providerEventSchema", () => {
  it("accepts notification events with routing metadata", () => {
    const parsed = providerEventSchema.parse({
      id: "evt_1",
      kind: "notification",
      provider: "codex",
      sessionId: "sess_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      method: "item/agentMessage/delta",
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "item_1",
      textDelta: "hi",
    });
    expect(parsed.method).toBe("item/agentMessage/delta");
  });

  it("accepts request approval metadata", () => {
    const parsed = providerEventSchema.parse({
      id: "evt_2",
      kind: "request",
      provider: "codex",
      sessionId: "sess_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      method: "item/commandExecution/requestApproval",
      requestId: "req_123",
      requestKind: "command",
    });
    expect(parsed.requestId).toBe("req_123");
    expect(parsed.requestKind).toBe("command");
  });
});

describe("providerRespondToRequestInputSchema", () => {
  it("accepts valid decisions", () => {
    const parsed = providerRespondToRequestInputSchema.parse({
      sessionId: "sess_1",
      requestId: "req_1",
      decision: "acceptForSession",
    });
    expect(parsed.decision).toBe("acceptForSession");
  });

  it("rejects unknown decisions", () => {
    expect(() =>
      providerRespondToRequestInputSchema.parse({
        sessionId: "sess_1",
        requestId: "req_1",
        decision: "always",
      }),
    ).toThrow();
  });
});
