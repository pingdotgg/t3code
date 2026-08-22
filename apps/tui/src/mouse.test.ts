import { describe, expect, it } from "bun:test";

import { deferMouseAction } from "./mouse.ts";

describe("deferMouseAction", () => {
  it("runs a tree-changing action after the current mouse dispatch", async () => {
    let calls = 0;
    const deferred = deferMouseAction(() => {
      calls += 1;
    });

    deferred();
    expect(calls).toBe(0);

    await Promise.resolve();
    expect(calls).toBe(1);
  });

  it("coalesces repeated calls in one mouse dispatch", async () => {
    let calls = 0;
    const deferred = deferMouseAction(() => {
      calls += 1;
    });

    deferred();
    deferred();
    await Promise.resolve();

    expect(calls).toBe(1);
  });
});
