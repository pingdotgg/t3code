import { describe, expect, it } from "vite-plus/test";

import { resolveThreadSyncPhase } from "./threadSync";

describe("resolveThreadSyncPhase", () => {
  it("stops syncing cached detail on terminal error and resumes when recovery clears it", () => {
    const cachedDetail = {
      detailExists: true,
      shellExists: true,
      status: "cached" as const,
      detailError: null,
    };
    expect(resolveThreadSyncPhase(cachedDetail)).toBe("syncing");

    const failedDetail = {
      ...cachedDetail,
      detailError:
        "Message synchronization timed out. Reconnect or return to the app to try again.",
    };
    expect.soft(resolveThreadSyncPhase(failedDetail)).toBeNull();

    const recoveringDetail = {
      ...failedDetail,
      status: "synchronizing" as const,
      detailError: null,
    };
    expect(resolveThreadSyncPhase(recoveringDetail)).toBe("syncing");
  });
});
