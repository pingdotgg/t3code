import { describe, expect, it } from "bun:test";

import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  deriveContextWindow,
  formatContextWindow,
  formatTokens,
  meterBar,
} from "./contextWindow.ts";

const ctxActivity = (
  usedTokens: number,
  maxTokens: number | null,
  createdAt: string,
): OrchestrationThreadActivity =>
  ({
    id: createdAt,
    tone: "info",
    kind: "context-window.updated",
    summary: "ctx",
    payload: { usedTokens, maxTokens },
    turnId: null,
    createdAt,
  }) as OrchestrationThreadActivity;

describe("deriveContextWindow", () => {
  it("Given context-window activities, then it uses the most recent and computes the percentage", () => {
    const snapshot = deriveContextWindow([
      ctxActivity(50_000, 200_000, "2026-06-19T00:00:00.000Z"),
      ctxActivity(144_000, 200_000, "2026-06-19T00:00:05.000Z"),
    ]);
    expect(snapshot).toEqual({
      usedTokens: 144_000,
      maxTokens: 200_000,
      remainingTokens: 56_000,
      usedPercentage: 72,
    });
  });

  it("Given no max, then the percentage and remaining are null", () => {
    const snapshot = deriveContextWindow([ctxActivity(1234, null, "2026-06-19T00:00:00.000Z")]);
    expect(snapshot?.usedPercentage).toBeNull();
    expect(snapshot?.remainingTokens).toBeNull();
  });

  it("Given no context-window activities, then it returns null", () => {
    expect(
      deriveContextWindow([{ kind: "tool.updated" } as OrchestrationThreadActivity]),
    ).toBeNull();
  });
});

describe("formatting", () => {
  it("formats token counts compactly", () => {
    expect(formatTokens(940)).toBe("940");
    expect(formatTokens(8_500)).toBe("8.5k");
    expect(formatTokens(144_000)).toBe("144k");
    expect(formatTokens(1_200_000)).toBe("1.2m");
  });

  it("renders a proportional bar", () => {
    expect(meterBar(50, 10)).toBe("▓▓▓▓▓░░░░░");
    expect(meterBar(null, 4)).toBe("░░░░");
  });

  it("formats the full meter and falls back when the max is unknown", () => {
    expect(
      formatContextWindow({
        usedTokens: 144_000,
        maxTokens: 200_000,
        remainingTokens: 56_000,
        usedPercentage: 72,
      }),
    ).toContain("72% · 144k/200k");
    expect(
      formatContextWindow({
        usedTokens: 1234,
        maxTokens: null,
        remainingTokens: null,
        usedPercentage: null,
      }),
    ).toBe("1.2k used");
  });
});
