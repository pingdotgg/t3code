import { describe, expect, it } from "vite-plus/test";

import { resolveThreadSyncPhase, threadSyncFloatingStatus } from "./floating-working-status";

describe("thread sync status", () => {
  it("shows a failure instead of syncing over cached messages", () => {
    expect(resolveThreadSyncPhase({ status: "cached", hasError: true, contentKind: "ready" })).toBe(
      "failed",
    );
    expect(threadSyncFloatingStatus("failed")).toMatchObject({
      kind: "connection",
      tone: "unavailable",
      label: "Could not sync messages",
    });
    expect(threadSyncFloatingStatus("failed")).not.toHaveProperty("onPress");
    expect(
      resolveThreadSyncPhase({ status: "cached", hasError: false, contentKind: "ready" }),
    ).toBe("syncing");
  });
});
