import "../../index.css";

import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ContextWindowSnapshot } from "../../lib/contextWindow";
import { ContextWindowMeter } from "./ContextWindowMeter";

function makeUsage(overrides: Partial<ContextWindowSnapshot> = {}): ContextWindowSnapshot {
  return {
    usedTokens: 16_384,
    totalProcessedTokens: 16_384,
    maxTokens: 39_010,
    remainingTokens: 22_626,
    usedPercentage: 42,
    remainingPercentage: 58,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: false,
    updatedAt: new Date("2026-04-26T00:00:00.000Z").toISOString(),
    ...overrides,
  };
}

describe("ContextWindowMeter", () => {
  it("shows a labeled percentage exactly once", async () => {
    const host = document.createElement("div");
    document.body.append(host);

    const screen = await render(<ContextWindowMeter usage={makeUsage()} variant="labeled" />, {
      container: host,
    });

    await vi.waitFor(() => {
      const matches = (document.body.textContent ?? "").match(/42%/g) ?? [];
      expect(matches).toHaveLength(1);
    });

    await screen.unmount();
    host.remove();
  });

  it("falls back to token count when percentage is unavailable", async () => {
    const host = document.createElement("div");
    document.body.append(host);

    const screen = await render(
      <ContextWindowMeter
        usage={makeUsage({ maxTokens: null, remainingTokens: null, usedPercentage: null })}
        variant="labeled"
      />,
      { container: host },
    );

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("16k");
    });

    await screen.unmount();
    host.remove();
  });
});
