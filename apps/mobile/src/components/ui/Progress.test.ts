import { expect, it } from "vite-plus/test";

import { resolveProgress, type ProgressProps } from "./Progress.types";

it.each<{ input: ProgressProps; fraction: number; percent: number }>([
  { input: { percent: 0 }, fraction: 0, percent: 0 },
  { input: { percent: 29 }, fraction: 0.29, percent: 29 },
  { input: { percent: 57 }, fraction: 0.57, percent: 57 },
  { input: { percent: 58 }, fraction: 0.58, percent: 58 },
  { input: { percent: 99 }, fraction: 0.99, percent: 99 },
  { input: { value: 0.299 }, fraction: 0.299, percent: 29 },
])("uses $fraction for the bar and announces $percent percent", ({ input, fraction, percent }) => {
  expect(resolveProgress(input)).toEqual({ fraction, now: percent });
});

it("keeps progress indeterminate without a finite measurement", () => {
  expect(resolveProgress({})).toBeUndefined();
  expect(resolveProgress({ percent: Number.NaN })).toBeUndefined();
});
