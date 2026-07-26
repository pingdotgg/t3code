import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { claimThreadsForBatch, releaseThreadKeys } from "./inFlightThreadKeys";
import { scopedThreadKey } from "./scopedEntities";

function makeThread(environment: string, id: string) {
  return {
    environmentId: EnvironmentId.make(environment),
    id: ThreadId.make(id),
  };
}

const ALPHA = makeThread("env-1", "alpha");
const BETA = makeThread("env-1", "beta");
// A project group can span environments, so the same thread id in a different
// environment has to claim a distinct key.
const ALPHA_OTHER_ENV = makeThread("env-2", "alpha");

const alphaKey = scopedThreadKey(ALPHA.environmentId, ALPHA.id);
const betaKey = scopedThreadKey(BETA.environmentId, BETA.id);

describe("claimThreadsForBatch", () => {
  it("claims every thread and records their keys", () => {
    const inFlight = new Set<string>();
    const claimed = claimThreadsForBatch([ALPHA, BETA], inFlight);

    expect(claimed.map((entry) => entry.thread.id)).toEqual(["alpha", "beta"]);
    expect([...inFlight]).toEqual([alphaKey, betaKey]);
  });

  it("skips a thread a single-thread action already owns", () => {
    // Swipe-archive on alpha is mid-flight when the group archive starts;
    // submitting a second thread.archive for it would be rejected.
    const inFlight = new Set([alphaKey]);
    const claimed = claimThreadsForBatch([ALPHA, BETA], inFlight);

    expect(claimed.map((entry) => entry.thread.id)).toEqual(["beta"]);
    expect(inFlight.size).toBe(2);
  });

  it("claims nothing when every thread is already in flight", () => {
    const inFlight = new Set([alphaKey, betaKey]);
    expect(claimThreadsForBatch([ALPHA, BETA], inFlight)).toEqual([]);
  });

  it("claims the whole batch up front, so a later thread is blocked immediately", () => {
    const inFlight = new Set<string>();
    claimThreadsForBatch([ALPHA, BETA], inFlight);
    // A swipe on beta while the batch is still working through alpha.
    expect(inFlight.has(betaKey)).toBe(true);
  });

  it("blocks a second batch over the same threads until the first releases", () => {
    const inFlight = new Set<string>();
    const first = claimThreadsForBatch([ALPHA, BETA], inFlight);
    expect(claimThreadsForBatch([ALPHA, BETA], inFlight)).toEqual([]);

    releaseThreadKeys(first, inFlight);
    expect(inFlight.size).toBe(0);
    expect(claimThreadsForBatch([ALPHA, BETA], inFlight)).toHaveLength(2);
  });

  it("keys by environment as well as thread id", () => {
    const inFlight = new Set<string>();
    expect(claimThreadsForBatch([ALPHA, ALPHA_OTHER_ENV], inFlight)).toHaveLength(2);
    expect(inFlight.size).toBe(2);
  });

  it("handles an empty batch", () => {
    const inFlight = new Set<string>();
    expect(claimThreadsForBatch([], inFlight)).toEqual([]);
    expect(inFlight.size).toBe(0);
  });
});

describe("releaseThreadKeys", () => {
  it("leaves keys it does not own alone", () => {
    const inFlight = new Set([alphaKey, betaKey]);
    releaseThreadKeys([{ key: alphaKey }], inFlight);
    expect([...inFlight]).toEqual([betaKey]);
  });
});
