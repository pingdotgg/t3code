import { expect, it } from "@effect/vitest";
import { miniMaxWindows } from "./minimaxQuota.ts";

it("uses remaining percentages when counts are zero and skips inactive windows", () => {
  expect(
    miniMaxWindows({
      model_remains: [
        {
          model_name: "general",
          current_interval_total_count: 0,
          current_interval_usage_count: 0,
          current_interval_remaining_percent: 72,
          current_weekly_remaining_percent: 99,
          current_weekly_status: 3,
        },
      ],
    }),
  ).toEqual([
    { id: "general:current_interval", kind: "session", label: "general session", usedPercent: 28 },
  ]);
  expect(
    miniMaxWindows({
      model_remains: [
        {
          model_name: "MiniMax-M3",
          current_interval_total_count: 100,
          current_interval_usage_count: 80,
        },
      ],
    })[0]?.usedPercent,
  ).toBe(20);
  expect(
    miniMaxWindows({
      model_remains: [
        { model_name: "general", current_interval_total_count: 0, current_interval_usage_count: 0 },
      ],
    }),
  ).toEqual([]);
});
