import { describe, expect, it } from "vite-plus/test";

import {
  PREVIEW_HOST_RESPONSE_MARGIN_MS,
  resolveHostWaitBudgetMs,
} from "./previewAutomationHostBudget";

describe("resolveHostWaitBudgetMs", () => {
  it("always expires before the broker deadline, at every request budget", () => {
    // The whole point of the helper: the host must lose no race, at any scale.
    for (const requestTimeoutMs of [1, 2, 10, 100, 249, 250, 999, 1_500, 3_000, 15_000, 60_000]) {
      expect(resolveHostWaitBudgetMs(requestTimeoutMs)).toBeLessThan(requestTimeoutMs);
    }
  });

  it("reserves the full response margin once the request budget allows it", () => {
    expect(resolveHostWaitBudgetMs(15_000)).toBe(15_000 - PREVIEW_HOST_RESPONSE_MARGIN_MS);
    expect(resolveHostWaitBudgetMs(60_000)).toBe(60_000 - PREVIEW_HOST_RESPONSE_MARGIN_MS);
  });

  it("keeps most of a short request budget instead of collapsing it", () => {
    expect(resolveHostWaitBudgetMs(1_000)).toBe(800);
    expect(resolveHostWaitBudgetMs(100)).toBe(80);
  });

  it("grows monotonically with the request budget", () => {
    const budgets = [1, 10, 100, 1_000, 3_000, 15_000].map(resolveHostWaitBudgetMs);
    for (let index = 1; index < budgets.length; index += 1) {
      expect(budgets[index]!).toBeGreaterThanOrEqual(budgets[index - 1]!);
    }
  });

  it("returns a non-negative budget for invalid input", () => {
    for (const invalid of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveHostWaitBudgetMs(invalid)).toBeGreaterThanOrEqual(0);
    }
  });
});
