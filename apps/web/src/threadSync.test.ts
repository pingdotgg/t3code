import { describe, expect, it } from "vite-plus/test";

import { resolveThreadSyncPhase } from "./threadSync";

describe("resolveThreadSyncPhase", () => {
  it.each([false, true])(
    "does not report progress after a failed load (detail: %s)",
    (detailExists) => {
      const failed = {
        detailExists,
        shellExists: true,
        status: "synchronizing" as const,
        error: "Could not synchronize the thread.",
      };
      expect(resolveThreadSyncPhase(failed)).toBeNull();
      expect(resolveThreadSyncPhase({ ...failed, error: null })).toBe(
        detailExists ? "syncing" : "loading",
      );
    },
  );

  it("loads when only shell data is available", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: true,
        status: "synchronizing",
      }),
    ).toBe("loading");
  });

  it("syncs when cached detail is already visible", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "cached",
      }),
    ).toBe("syncing");
  });

  it("does not report a sync phase without a shell or after going live", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: false,
        status: "empty",
      }),
    ).toBeNull();
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "live",
      }),
    ).toBeNull();
  });
});
