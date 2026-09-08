import { describe, expect, it } from "vite-plus/test";

import * as ThreadPinAction from "./threadPinAction";

describe("pin action ownership", () => {
  it("does not revive the first Undo after a later pin and unpin finish", () => {
    const firstUnpin = ThreadPinAction.begin("env/thread");
    const pin = ThreadPinAction.begin("env/thread");
    pin.finish();
    const secondUnpin = ThreadPinAction.begin("env/thread");
    expect(firstUnpin.isCurrent()).toBe(false);
    expect(secondUnpin.isCurrent()).toBe(true);
    firstUnpin.finish();
    expect(secondUnpin.isCurrent()).toBe(true);
    secondUnpin.finish();
    expect(firstUnpin.isCurrent()).toBe(false);
  });

  it("rejects late completion after a newer action has already completed", () => {
    const pendingUnpin = ThreadPinAction.begin("env/late");
    const newerPin = ThreadPinAction.begin("env/late");
    newerPin.finish();
    expect(pendingUnpin.isCurrent()).toBe(false);
    pendingUnpin.finish();
  });

  it("expires an Undo without invalidating another environment or thread", () => {
    const first = ThreadPinAction.begin("one/thread");
    const otherEnvironment = ThreadPinAction.begin("two/thread");
    const otherThread = ThreadPinAction.begin("one/other");
    first.finish();
    expect(first.isCurrent()).toBe(false);
    expect(otherEnvironment.isCurrent()).toBe(true);
    expect(otherThread.isCurrent()).toBe(true);
    otherEnvironment.finish();
    otherThread.finish();
  });
});
