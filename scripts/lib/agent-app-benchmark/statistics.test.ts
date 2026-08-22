import { assert, describe, it } from "@effect/vitest";

import {
  bootstrapMedianInterval,
  comparePairedSamples,
  median,
  pairedBootstrapDifferenceInterval,
  percentile,
  seededShuffle,
} from "./statistics.ts";

describe("agent app benchmark statistics", () => {
  it("computes documented medians for odd and even samples", () => {
    assert.equal(median([9, 1, 5]), 5);
    assert.equal(median([10, 2, 8, 4]), 6);
  });

  it("computes a within-run p95 without mutating the samples", () => {
    const samples = [10, 20, 30, 40, 50];
    assert.equal(percentile(samples, 0.95), 48);
    assert.deepStrictEqual(samples, [10, 20, 30, 40, 50]);
  });

  it("produces reproducible bootstrap intervals from a seed", () => {
    const first = bootstrapMedianInterval([8, 9, 10, 11, 12], {
      seed: 42,
      iterations: 2_000,
    });
    const second = bootstrapMedianInterval([8, 9, 10, 11, 12], {
      seed: 42,
      iterations: 2_000,
    });
    assert.deepStrictEqual(first, second);
    assert.ok(first.low <= 10);
    assert.ok(first.high >= 10);
  });

  it("bootstraps paired differences rather than comparing independent intervals", () => {
    const interval = pairedBootstrapDifferenceInterval(
      [100, 105, 98, 102, 101],
      [90, 94, 89, 92, 91],
      { seed: 7, iterations: 2_000 },
    );
    assert.ok(interval.low < 0);
    assert.ok(interval.high < 0);
  });

  it("does not make a directional claim when the paired interval contains zero", () => {
    const comparison = comparePairedSamples({
      baseline: [100, 90, 110, 95, 105],
      candidate: [99, 94, 106, 97, 104],
      seed: 9,
      iterations: 2_000,
      resolution: 1,
      invalidAttempts: 0,
    });
    assert.equal(comparison.decision, "no-clear-difference");
  });

  it("names the lower side when the paired interval clears the resolution band", () => {
    const faster = comparePairedSamples({
      baseline: [1_000, 1_010, 1_005, 1_002, 1_008],
      candidate: [100, 101, 99, 102, 100],
      seed: 3,
      iterations: 2_000,
      resolution: 1,
      invalidAttempts: 0,
    });
    assert.equal(faster.decision, "candidate-lower");
    assert.ok(faster.differenceInterval.high < 0);

    const slower = comparePairedSamples({
      baseline: [100, 101, 99, 102, 100],
      candidate: [1_000, 1_010, 1_005, 1_002, 1_008],
      seed: 3,
      iterations: 2_000,
      resolution: 1,
      invalidAttempts: 0,
    });
    assert.equal(slower.decision, "baseline-lower");
    assert.ok(slower.differenceInterval.low > 0);
  });

  it("keeps a difference smaller than the disclosed resolution a tie", () => {
    const comparison = comparePairedSamples({
      baseline: [1_000, 1_001, 1_002, 1_003, 1_004],
      candidate: [997, 998, 999, 1_000, 1_001],
      seed: 4,
      iterations: 2_000,
      resolution: 10,
      invalidAttempts: 0,
    });
    // The interval excludes zero, but a 3 ms shift is inside a 10 ms
    // disclosed resolution, so no direction may be claimed.
    assert.ok(comparison.differenceInterval.high < 0);
    assert.equal(comparison.decision, "no-clear-difference");
  });

  it("prevents ranking when any measured attempt is invalid", () => {
    const comparison = comparePairedSamples({
      baseline: [100, 101, 102],
      candidate: [80, 81, 82],
      seed: 1,
      iterations: 1_000,
      resolution: 1,
      invalidAttempts: 1,
    });
    assert.equal(comparison.decision, "not-rankable");
  });

  it("records deterministic seeded ordering", () => {
    const input = ["a", "b", "c", "d", "e"];
    assert.deepStrictEqual(seededShuffle(input, 123), seededShuffle(input, 123));
    assert.deepStrictEqual([...seededShuffle(input, 123)].sort(), input);
    assert.deepStrictEqual(input, ["a", "b", "c", "d", "e"]);
  });
});
