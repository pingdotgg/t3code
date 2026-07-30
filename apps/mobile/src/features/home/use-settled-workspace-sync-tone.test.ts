import { describe, expect, it } from "vite-plus/test";

import {
  planWorkspaceSyncToneSettlement,
  SYNC_TONE_ENTER_DELAY_MS,
} from "./use-settled-workspace-sync-tone";

describe("workspace sync tone settlement", () => {
  it("delays a newly-started sync instead of showing it immediately", () => {
    // The sub-second sync blips a healthy connection produces never survive
    // this delay, which is the whole point — they used to strobe the indicator.
    expect(
      planWorkspaceSyncToneSettlement({
        rawTone: "syncing",
        settledTone: "idle",
        holdUntil: 0,
        now: 1_000,
      }),
    ).toEqual({ kind: "schedule", tone: "syncing", delayMs: SYNC_TONE_ENTER_DELAY_MS });
  });

  it("does nothing while the shown tone already matches", () => {
    expect(
      planWorkspaceSyncToneSettlement({
        rawTone: "syncing",
        settledTone: "syncing",
        holdUntil: 5_000,
        now: 1_000,
      }),
    ).toEqual({ kind: "hold" });
  });

  it("surfaces a real fault immediately, even over a held spinner", () => {
    expect(
      planWorkspaceSyncToneSettlement({
        rawTone: "offline",
        settledTone: "syncing",
        holdUntil: 5_000,
        now: 1_000,
      }),
    ).toEqual({ kind: "apply", tone: "offline" });
  });

  it("clears to idle once the minimum-visible hold has elapsed", () => {
    expect(
      planWorkspaceSyncToneSettlement({
        rawTone: "idle",
        settledTone: "syncing",
        holdUntil: 900,
        now: 1_000,
      }),
    ).toEqual({ kind: "apply", tone: "idle" });
  });

  it("defers clearing to idle for the remainder of the hold", () => {
    // Shown at t=1000 with a 900ms floor; a sync that resolves at t=1200 must
    // still leave the spinner up for the remaining 700ms rather than blinking.
    expect(
      planWorkspaceSyncToneSettlement({
        rawTone: "idle",
        settledTone: "syncing",
        holdUntil: 1_900,
        now: 1_200,
      }),
    ).toEqual({ kind: "schedule", tone: "idle", delayMs: 700 });
  });

  it("re-delays when swapping between two transient tones", () => {
    expect(
      planWorkspaceSyncToneSettlement({
        rawTone: "syncing",
        settledTone: "connecting",
        holdUntil: 0,
        now: 1_000,
      }),
    ).toEqual({ kind: "schedule", tone: "syncing", delayMs: SYNC_TONE_ENTER_DELAY_MS });
  });
});
