import { expect, it, vi } from "vite-plus/test";

import {
  SHIMMER_PAUSE_MS,
  SHIMMER_STEPS,
  SHIMMER_SWEEP_MS,
  startShimmerSteps,
} from "./work-shimmer-steps";

it("steps the sweep, stays quiet through the pause, and stops on cleanup", () => {
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  vi.useFakeTimers();
  const values: number[] = [];
  const stop = startShimmerSteps({ setValue: (value) => values.push(value) });
  const valuesDuring = (ms: number) => {
    vi.advanceTimersByTime(ms);
    return values.splice(0);
  };

  const sweep = valuesDuring(SHIMMER_SWEEP_MS);
  expect(sweep).toHaveLength(SHIMMER_STEPS);
  expect(sweep.at(-1)).toBe(1);
  expect(sweep).toEqual([...sweep].sort((a, b) => a - b));
  expect(valuesDuring(SHIMMER_PAUSE_MS)).toEqual([]);
  expect(valuesDuring(SHIMMER_SWEEP_MS)).toEqual(sweep);

  stop();
  expect(vi.getTimerCount()).toBe(0);
  expect(valuesDuring((SHIMMER_SWEEP_MS + SHIMMER_PAUSE_MS) * 2)).toEqual([]);
});
