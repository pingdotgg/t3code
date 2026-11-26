import { expect, it } from "vite-plus/test";

import { resolveProgress, type ProgressProps } from "./Progress.types";

it.each<{ input: ProgressProps; fraction: number; percent: number }>([
  { input: { percent: 29 }, fraction: 0.29, percent: 29 },
  { input: { value: 0.299 }, fraction: 0.299, percent: 29 },
])("uses $fraction for the bar and announces $percent percent", ({ input, fraction, percent }) => {
  expect(resolveProgress(input)).toEqual({ fraction, now: percent });
});

it("keeps progress indeterminate without a finite measurement", () => {
  expect(resolveProgress({})).toBeUndefined();
  expect(resolveProgress({ percent: Number.NaN })).toBeUndefined();
});
