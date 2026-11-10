import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { registerSettleAndAdvance, settleAndAdvance } from "./settleAndAdvance";

const threadRef = scopeThreadRef(
  EnvironmentId.make("environment-local"),
  ThreadId.make("thread-1"),
);

describe("settleAndAdvance", () => {
  it("keeps a remounted sidebar's handler when the old one unmounts late", () => {
    const settledBy: string[] = [];
    const unregisterOld = registerSettleAndAdvance(() => settledBy.push("old"));
    const unregisterNew = registerSettleAndAdvance(() => settledBy.push("new"));
    unregisterOld();

    expect(settleAndAdvance(threadRef)).toBe(true);
    expect(settledBy).toEqual(["new"]);
    unregisterNew();
    expect(settleAndAdvance(threadRef)).toBe(false);
  });
});
