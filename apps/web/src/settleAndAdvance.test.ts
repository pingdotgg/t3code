import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { registerSettleAndAdvance, settleAndAdvance } from "./settleAndAdvance";

const threadRef = scopeThreadRef(
  EnvironmentId.make("environment-local"),
  ThreadId.make("thread-1"),
);

describe("settleAndAdvance", () => {
  it("hands the open thread to the mounted sidebar so it can move forward", () => {
    const settled: ScopedThreadRef[] = [];
    const unregister = registerSettleAndAdvance((ref) => settled.push(ref));

    expect(settleAndAdvance(threadRef)).toBe(true);
    expect(settled).toEqual([threadRef]);
    unregister();
  });

  it("asks the caller to settle in place when no sidebar is mounted", () => {
    expect(settleAndAdvance(threadRef)).toBe(false);
  });

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
