import { expect, it } from "vite-plus/test";
import { formatSessionCost, sessionTokenCount } from "./sessionUsage";

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
