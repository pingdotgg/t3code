import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  PREVIEW_HOST_RESPONSE_MARGIN_MS,
  resolveHostWaitBudgetMs,
  waitForHostReadiness,
} from "./previewAutomationHostBudget";

describe("resolveHostWaitBudgetMs", () => {
  it("reserves the full response margin once the request budget allows it", () => {
    expect(resolveHostWaitBudgetMs(15_000)).toBe(15_000 - PREVIEW_HOST_RESPONSE_MARGIN_MS);
    expect(resolveHostWaitBudgetMs(60_000)).toBe(60_000 - PREVIEW_HOST_RESPONSE_MARGIN_MS);
  });

  it("keeps most of a short request budget instead of collapsing it", () => {
    expect(resolveHostWaitBudgetMs(1_000)).toBe(800);
    expect(resolveHostWaitBudgetMs(100)).toBe(80);
  });

  it("returns a non-negative budget for invalid input", () => {
    for (const invalid of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveHostWaitBudgetMs(invalid)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("waitForHostReadiness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([1, 10, 100, 250, 1_000, 15_000])(
    "stops unavailable-overlay polling before a %ims broker timeout",
    async (requestTimeoutMs) => {
      const deadlineMs = Date.now() + resolveHostWaitBudgetMs(requestTimeoutMs);
      let finishedAt: number | undefined;
      const result = waitForHostReadiness(deadlineMs, async () => false).then((ready) => {
        finishedAt = Date.now();
        return ready;
      });

      await vi.advanceTimersByTimeAsync(requestTimeoutMs);

      expect(await result).toBe(false);
      expect(finishedAt).toBeLessThan(requestTimeoutMs);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("includes session setup in the deadline instead of starting a fresh wait budget", async () => {
    const deadlineMs = Date.now() + resolveHostWaitBudgetMs(15_000);
    await vi.advanceTimersByTimeAsync(2_000);
    let finished = false;
    const result = waitForHostReadiness(deadlineMs, async () => false).then((ready) => {
      finished = true;
      return ready;
    });

    await vi.advanceTimersByTimeAsync(11_499);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(false);
    expect(Date.now()).toBe(deadlineMs);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips readiness probes when setup has already exhausted the deadline", async () => {
    const deadlineMs = Date.now() + resolveHostWaitBudgetMs(100);
    await vi.advanceTimersByTimeAsync(100);
    const isReady = vi.fn(async () => false);

    expect(await waitForHostReadiness(deadlineMs, isReady)).toBe(false);
    expect(isReady).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns as soon as the overlay is ready and clears its timeout", async () => {
    const isReady = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const result = waitForHostReadiness(800, isReady);

    await vi.advanceTimersByTimeAsync(50);

    expect(await result).toBe(true);
    expect(isReady).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    "keeps a probe result of %s that wins the deadline race",
    async (ready) => {
      const isReady = vi.fn(
        () => new Promise<boolean>((resolve) => setTimeout(() => resolve(ready), 80)),
      );
      const result = waitForHostReadiness(80, isReady);

      await vi.advanceTimersByTimeAsync(80);

      expect(await result).toBe(ready);
      expect(isReady).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds a stalled status probe and ignores a late ready result", async () => {
    let completeProbe!: (ready: boolean) => void;
    const isReady = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          completeProbe = resolve;
        }),
    );
    const result = waitForHostReadiness(80, isReady);

    await vi.advanceTimersByTimeAsync(80);
    expect(await result).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    completeProbe(true);
    await vi.runAllTimersAsync();
    expect(isReady).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves probe failures and clears the pending timeout", async () => {
    const error = new Error("Preview target was replaced");
    const isReady = vi.fn().mockRejectedValue(error);

    await expect(waitForHostReadiness(800, isReady)).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });
});
