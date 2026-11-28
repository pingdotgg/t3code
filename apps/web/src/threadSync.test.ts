import { describe, expect, it } from "vite-plus/test";

import { resolveThreadSyncPhase } from "./threadSync";

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
