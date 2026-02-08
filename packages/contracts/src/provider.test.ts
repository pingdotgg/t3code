import { describe, expect, it } from "vitest";

import {
  providerEventSchema,
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
});

describe("providerSendTurnInputSchema", () => {
  it("trims input text", () => {
    const parsed = providerSendTurnInputSchema.parse({
      sessionId: "sess_1",
      input: "  summarize this repo  ",
    });
    expect(parsed.input).toBe("summarize this repo");
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
});
