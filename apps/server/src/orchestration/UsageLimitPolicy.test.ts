import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { evaluateTurnStartLimits, DEFAULT_THREAD_CONTEXT_TOKEN_LIMIT } from "./UsageLimitPolicy.ts";

function contextActivity(usedTokens: number): OrchestrationThreadActivity {
  return {
    id: `usage-${usedTokens}`,
    createdAt: "2026-08-31T00:00:00.000Z",
    tone: "info",
    kind: "context-window.updated",
    summary: "Context window updated",
    payload: { usedTokens, maxTokens: 400_000 },
    turnId: null,
  } as OrchestrationThreadActivity;
}

describe("evaluateTurnStartLimits", () => {
  it("blocks a thread at the context ceiling", () => {
    const violation = evaluateTurnStartLimits({
      activities: [contextActivity(DEFAULT_THREAD_CONTEXT_TOKEN_LIMIT)],
    });

    expect(violation?.code).toBe("context-limit");
  });

  it("uses the latest context snapshot", () => {
    const violation = evaluateTurnStartLimits({
      activities: [contextActivity(DEFAULT_THREAD_CONTEXT_TOKEN_LIMIT), contextActivity(20_000)],
    });

    expect(violation).toBeUndefined();
  });

  it("uses the configured context ceiling", () => {
    const violation = evaluateTurnStartLimits({
      contextTokenLimit: 100_000,
      activities: [contextActivity(100_000)],
    });

    expect(violation?.code).toBe("context-limit");
    expect(violation?.detail).toContain("100,000");
  });
});
