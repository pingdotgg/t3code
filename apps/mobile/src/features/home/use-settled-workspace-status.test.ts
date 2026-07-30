import { describe, expect, it } from "vite-plus/test";

import {
  planWorkspaceStatusSettlement,
  STATUS_BUSY_ENTER_DELAY_MS,
} from "./use-settled-workspace-status";

describe("workspace status settlement", () => {
  it("delays going busy instead of switching immediately", () => {
    // The sub-second sync blips a healthy connection produces never survive
    // this delay — which is the point; they used to strobe the indicator.
    expect(
      planWorkspaceStatusSettlement({
        rawBusy: true,
        settledBusy: false,
        holdUntil: 0,
        now: 1_000,
      }),
    ).toEqual({ kind: "schedule", busy: true, delayMs: STATUS_BUSY_ENTER_DELAY_MS });
  });

  it("does nothing while the shown state already matches", () => {
    expect(
      planWorkspaceStatusSettlement({
        rawBusy: true,
        settledBusy: true,
        holdUntil: 5_000,
        now: 1_000,
      }),
    ).toEqual({ kind: "hold" });
  });

  it("goes quiet immediately once the minimum-visible hold has elapsed", () => {
    expect(
      planWorkspaceStatusSettlement({
        rawBusy: false,
        settledBusy: true,
        holdUntil: 900,
        now: 1_000,
      }),
    ).toEqual({ kind: "apply", busy: false });
  });

  it("defers going quiet for the remainder of the hold", () => {
    // Shown at t=1000 with a 900ms floor; a sync that resolves at t=1200 still
    // leaves the busy status up for the remaining 700ms rather than blinking.
    expect(
      planWorkspaceStatusSettlement({
        rawBusy: false,
        settledBusy: true,
        holdUntil: 1_900,
        now: 1_200,
      }),
    ).toEqual({ kind: "schedule", busy: false, delayMs: 700 });
  });
});
