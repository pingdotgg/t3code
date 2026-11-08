import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  clearPendingReveal,
  readPendingRevealForTests as readPending,
  recordThreadViewed,
  RETURN_PULSE_TRANSITION_MS,
  requestThreadReveal,
  resetReturnPulseForTests,
  revealReturnTarget,
} from "./return-pulse";

describe("return pulse", () => {
  afterEach(() => resetReturnPulseForTests());

  it("reveals the last viewed thread once, after the back transition", () => {
    recordThreadViewed("env:a");
    recordThreadViewed("env:b");
    revealReturnTarget(1_000);
    const reveal = readPending();
    expect(reveal?.threadKey).toBe("env:b");
    expect(reveal?.notBefore).toBe(1_000 + RETURN_PULSE_TRANSITION_MS);
    expect(reveal?.settledShelfFallback).toBe(true);
    clearPendingReveal(reveal!);
    revealReturnTarget(2_000);
    expect(readPending()).toBeNull();
  });

  it("reveals a thread restored by Undo without the shelf fallback", () => {
    requestThreadReveal("env:c", 5_000);
    expect(readPending()).toMatchObject({
      threadKey: "env:c",
      notBefore: 5_000,
      settledShelfFallback: false,
    });
  });

  it("does not clear a newer reveal with an older one", () => {
    requestThreadReveal("env:c", 0);
    const older = readPending()!;
    requestThreadReveal("env:d", 0);
    clearPendingReveal(older);
    expect(readPending()?.threadKey).toBe("env:d");
  });
});
