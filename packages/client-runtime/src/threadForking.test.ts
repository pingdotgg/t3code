import { MessageId, ProviderDriverKind, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveLatestForkableTurnId, supportsThreadFork } from "./threadForking.js";

describe("supportsThreadFork", () => {
  it("only enables providers with an exact native fork primitive", () => {
    expect(supportsThreadFork(ProviderDriverKind.make("codex"))).toBe(true);
    expect(supportsThreadFork(ProviderDriverKind.make("claudeAgent"))).toBe(true);
    expect(supportsThreadFork(ProviderDriverKind.make("opencode"))).toBe(true);
    expect(supportsThreadFork(ProviderDriverKind.make("cursor"))).toBe(false);
    expect(supportsThreadFork(ProviderDriverKind.make("grok"))).toBe(false);
    expect(supportsThreadFork(null)).toBe(false);
  });
});

describe("resolveLatestForkableTurnId", () => {
  const completedTurn = {
    turnId: TurnId.make("turn-1"),
    state: "completed" as const,
    requestedAt: "2026-07-23T00:00:00.000Z",
    startedAt: "2026-07-23T00:00:01.000Z",
    completedAt: "2026-07-23T00:00:02.000Z",
    assistantMessageId: MessageId.make("assistant-1"),
  };

  it("uses the latest completed assistant turn as the full-thread clone boundary", () => {
    expect(resolveLatestForkableTurnId(completedTurn)).toBe(completedTurn.turnId);
  });

  it("rejects running turns and turns without a completed assistant response", () => {
    expect(resolveLatestForkableTurnId({ ...completedTurn, state: "running" })).toBeNull();
    expect(resolveLatestForkableTurnId({ ...completedTurn, assistantMessageId: null })).toBeNull();
    expect(resolveLatestForkableTurnId(null)).toBeNull();
  });
});
