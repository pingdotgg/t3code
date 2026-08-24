import { deriveLatestContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatContextWindowDetail,
  formatContextWindowPercentage,
} from "./ContextWindowRing.logic";

function makeSnapshot(payload: Record<string, unknown>) {
  const activity: OrchestrationThreadActivity = {
    id: EventId.make("evt-1"),
    tone: "info",
    kind: "context-window.updated",
    summary: "Context window updated",
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-08-24T00:00:00.000Z",
  };
  const snapshot = deriveLatestContextWindowSnapshot([activity]);
  if (!snapshot) throw new Error("expected a snapshot");
  return snapshot;
}

describe("formatContextWindowPercentage", () => {
  it("keeps one decimal below ten percent and rounds above it", () => {
    expect(formatContextWindowPercentage(4.25)).toBe("4.3%");
    expect(formatContextWindowPercentage(42.4)).toBe("42%");
  });

  it("drops a trailing zero decimal", () => {
    expect(formatContextWindowPercentage(3)).toBe("3%");
  });

  it("has nothing to show without a percentage", () => {
    expect(formatContextWindowPercentage(null)).toBe(null);
  });
});

describe("formatContextWindowDetail", () => {
  it("reads as percentage plus used over max", () => {
    expect(
      formatContextWindowDetail(makeSnapshot({ usedTokens: 84_000, maxTokens: 200_000 })),
    ).toBe("Context window · 42% · 84k/200k");
  });

  it("falls back to a bare token count when the provider reports no maximum", () => {
    expect(formatContextWindowDetail(makeSnapshot({ usedTokens: 1400 }))).toBe(
      "Context window · 1.4k tokens used",
    );
  });
});
