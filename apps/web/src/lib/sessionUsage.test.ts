import { expect, it } from "vite-plus/test";
import { formatSessionCost, sessionTokenCount, sessionSpendRate } from "./sessionUsage";

it("measures recent spend without treating history, gaps or corrections as a burst", () => {
  expect(sessionSpendRate(10, 60_000, 12, 120_000)).toBe(2);
  expect(sessionSpendRate(10, 60_000, 10, 120_000)).toBe(0);
  expect(sessionSpendRate(10, 60_000, 9, 120_000)).toBe(0);
  expect(sessionSpendRate(0, 0, 100, 120_000)).toBe(0);
  expect(sessionSpendRate(10, 60_000, 100, 60_001)).toBe(0);
  expect(sessionSpendRate(10, 60_000, 100, 300_000)).toBe(0);
});

it("counts each billed token once, without adding reasoning twice", () => {
  expect(
    sessionTokenCount({
      uncachedInputTokens: 100,
      cachedInputTokens: 200,
      cacheCreationTokens: 30,
      outputTokens: 50,
      reasoningTokens: 20,
    }),
  ).toBe(380);
});

it("rounds the session estimate to whole dollars and marks partial pricing", () => {
  expect(formatSessionCost(12.49)).toBe("$12");
  expect(formatSessionCost(12.5)).toBe("$13");
  expect(formatSessionCost(0.12)).toBe("$0");
  expect(formatSessionCost(1234.8, true)).toBe("≥$1,235");
});
