import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import type { UsageBudgetStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ComposerUsageMeters } from "./ComposerUsageMeters";

const budget = (hourCostUsd: number): UsageBudgetStatus => ({
  state: "normal",
  hour: { costUsd: hourCostUsd, softLimitUsd: 27, hardLimitUsd: 30 },
  day: {
    costUsd: 127.33,
    softLimitUsd: 180,
    hardLimitUsd: 200,
    resetsAt: "2026-11-19T05:00:00.000Z",
  },
  overrideUntil: null,
  cacheHitPercent: 97.56,
});

const contextWindow: ContextWindowSnapshot = {
  usedTokens: 9_600,
  totalProcessedTokens: null,
  maxTokens: 272_000,
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
  compactsAutomatically: true,
  autoCompactThreshold: 250_808,
  cost: null,
  remainingTokens: 262_400,
  usedPercentage: 3.5,
  remainingPercentage: 96.5,
  updatedAt: "2026-11-18T19:00:00.000Z",
};

describe("ComposerUsageMeters", () => {
  it("shows the context window, hour and day spend, and cache rate", async () => {
    await render(<ComposerUsageMeters contextWindow={contextWindow} budget={budget(16.91)} />);
    await expect.element(page.getByLabelText("Context: 4% used")).toBeVisible();
    await expect.element(page.getByLabelText("Hour: $17/$30")).toBeVisible();
    await expect.element(page.getByLabelText("Today: $127/$200")).toBeVisible();
    await expect.element(page.getByLabelText("Cache: 98%")).toBeVisible();
  });

  it("colors a window that passed its soft limit", async () => {
    await render(<ComposerUsageMeters contextWindow={null} budget={budget(28)} />);
    await expect
      .element(page.getByLabelText("Hour: $28/$30").getByText("$28/$30"))
      .toHaveClass(/text-warning-foreground/);
  });

  it("shows nothing without a context window or budget", async () => {
    const screen = await render(<ComposerUsageMeters contextWindow={null} budget={null} />);
    expect(screen.container.textContent).toBe("");
  });
});
