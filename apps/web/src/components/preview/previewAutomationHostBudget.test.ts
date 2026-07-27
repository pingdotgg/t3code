import { describe, expect, it } from "vite-plus/test";

import {
  PREVIEW_HOST_RESPONSE_MARGIN_MS,
  resolveHostWaitBudgetMs,
} from "./previewAutomationHostBudget";

describe("resolveHostWaitBudgetMs", () => {
  it("expires before the broker deadline so the host failure wins the race", () => {
    const requestTimeoutMs = 15_000;
    const budget = resolveHostWaitBudgetMs(requestTimeoutMs);

    expect(budget).toBeLessThan(requestTimeoutMs);
    expect(requestTimeoutMs - budget).toBe(PREVIEW_HOST_RESPONSE_MARGIN_MS);
  });

  it("keeps a usable wait for short request budgets", () => {
    expect(resolveHostWaitBudgetMs(1_000)).toBeGreaterThan(0);
    expect(resolveHostWaitBudgetMs(1_000)).toBeLessThan(1_000);
    expect(resolveHostWaitBudgetMs(10)).toBeGreaterThan(0);
    expect(resolveHostWaitBudgetMs(10)).toBeLessThan(PREVIEW_HOST_RESPONSE_MARGIN_MS);
  });

  it("falls back to a positive budget for invalid input", () => {
    expect(resolveHostWaitBudgetMs(0)).toBeGreaterThan(0);
    expect(resolveHostWaitBudgetMs(-5)).toBeGreaterThan(0);
    expect(resolveHostWaitBudgetMs(Number.NaN)).toBeGreaterThan(0);
  });
});
