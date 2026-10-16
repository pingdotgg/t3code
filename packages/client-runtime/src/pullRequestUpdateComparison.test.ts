import { describe, expect, it } from "vite-plus/test";
import { resolvePullRequestUpdateComparison as resolve } from "./pullRequestUpdateComparison.ts";

describe("resolvePullRequestUpdateComparison", () => {
  it("reads base to latest as the live change rather than a historical range", () => {
    expect(resolve(null, 5)).toEqual({
      comparison: { from: 0, to: "latest" },
      iterationRange: undefined,
    });
    expect(resolve({ from: 0, to: "latest" }, 5).iterationRange).toBeUndefined();
    expect(resolve({ from: 0, to: "latest" }, 1).iterationRange).toBeUndefined();
  });

  it("keeps following the newest update after latest is picked", () => {
    const comparison = { from: 3, to: "latest" } as const;
    expect(resolve(comparison, 5).iterationRange).toEqual({ from: 3, to: 5 });
    expect(resolve(comparison, 7)).toEqual({ comparison, iterationRange: { from: 3, to: 7 } });
  });

  it("holds a numbered update when newer ones arrive, even one that was the latest", () => {
    expect(resolve({ from: 0, to: 5 }, 5).iterationRange).toEqual({ from: 0, to: 5 });
    expect(resolve({ from: 0, to: 5 }, 7).iterationRange).toEqual({ from: 0, to: 5 });
    expect(resolve({ from: 2, to: 4 }, 7).iterationRange).toEqual({ from: 2, to: 4 });
  });

  it("uses a linked range before the host has reported its updates", () => {
    expect(resolve({ from: 2, to: 4 }, undefined).iterationRange).toEqual({ from: 2, to: 4 });
    expect(resolve({ from: 2, to: "latest" }, undefined)).toEqual({
      comparison: { from: 0, to: "latest" },
      iterationRange: undefined,
    });
  });

  it("falls back to the whole change when the range is empty or reversed", () => {
    for (const comparison of [
      { from: 4, to: 4 },
      { from: 5, to: 2 },
      { from: 5, to: "latest" as const },
    ]) {
      expect(resolve(comparison, 5)).toEqual({
        comparison: { from: 0, to: "latest" },
        iterationRange: undefined,
      });
    }
  });
});
