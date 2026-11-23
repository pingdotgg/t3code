import { describe, expect, it } from "vite-plus/test";

import { isThreadCatchingUp, resolveThreadSyncPhase } from "./threadSync";

describe("resolveThreadSyncPhase", () => {
  it("reports a failed sync instead of syncing over cached messages", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "cached",
        hasError: true,
      }),
    ).toBe("failed");
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: true,
        status: "synchronizing",
        hasError: true,
      }),
    ).toBe("loading");
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "synchronizing",
        hasError: false,
      }),
    ).toBe("syncing");
  });
});

describe("isThreadCatchingUp", () => {
  const statuses = ["empty", "cached", "synchronizing", "live", "deleted"] as const;

  it("holds sends only for a cached copy that is still syncing with its environment reachable", () => {
    const held: string[] = [];
    for (const status of statuses) {
      for (const detailExists of [false, true]) {
        for (const hasError of [false, true]) {
          for (const environmentUnavailable of [false, true]) {
            const phase = resolveThreadSyncPhase({
              detailExists,
              shellExists: true,
              status,
              hasError,
            });
            if (isThreadCatchingUp(phase, environmentUnavailable)) {
              held.push(
                `${status} detail=${detailExists} error=${hasError} unavailable=${environmentUnavailable}`,
              );
            }
          }
        }
      }
    }
    // Held exactly where the timeline says "syncing". A failed sync, a missing copy, a live or
    // deleted thread and an unreachable environment never hold, so a broken sync cannot lock
    // the person out.
    expect(held).toEqual([
      "empty detail=true error=false unavailable=false",
      "cached detail=true error=false unavailable=false",
      "synchronizing detail=true error=false unavailable=false",
    ]);
  });
});
