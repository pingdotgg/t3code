import { describe, expect, it } from "@effect/vitest";

import type { SourceControlCloneProgress } from "@t3tools/contracts";

import {
  advanceSourceControlCloneProgress,
  completeSourceControlCloneProgress,
} from "./sourceControl.ts";

function progress(
  stage: SourceControlCloneProgress["stage"],
  percent: number | null,
): SourceControlCloneProgress {
  return {
    type: "progress",
    stage,
    percent,
    completed: null,
    total: null,
    receivedBytes: null,
    bytesPerSecond: null,
  };
}

describe("source control clone progress", () => {
  it("maps Git stages onto one overall zero-to-100 range", () => {
    const connecting = advanceSourceControlCloneProgress(null, progress("connecting", null));
    const receiving = advanceSourceControlCloneProgress(connecting, progress("receiving", 50));
    const resolving = advanceSourceControlCloneProgress(receiving, progress("resolving", 50));
    const checkout = advanceSourceControlCloneProgress(resolving, progress("checkout", 50));
    const complete = completeSourceControlCloneProgress(checkout);

    expect([
      connecting.overallPercent,
      receiving.overallPercent,
      resolving.overallPercent,
      checkout.overallPercent,
      complete.overallPercent,
    ]).toEqual([0, 40, 87.5, 97, 100]);
    expect(complete.isComplete).toBe(true);
  });

  it("never moves the overall progress or stage backward", () => {
    const resolving = advanceSourceControlCloneProgress(null, progress("resolving", 75));
    const lateReceiving = advanceSourceControlCloneProgress(resolving, progress("receiving", 100));

    expect(resolving.overallPercent).toBe(91.3);
    expect(lateReceiving).toMatchObject({
      stage: "resolving",
      overallPercent: 91.3,
      isComplete: false,
    });
  });

  it("reserves 100 percent for successful completion", () => {
    const checkout = advanceSourceControlCloneProgress(null, progress("checkout", 100));

    expect(checkout.overallPercent).toBe(99);
    expect(completeSourceControlCloneProgress(checkout)).toMatchObject({
      stage: "checkout",
      overallPercent: 100,
      isComplete: true,
    });
  });
});
