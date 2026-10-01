import { describe, expect, it } from "vite-plus/test";

import * as ThreadUndo from "./threadUndo";

describe("thread action ownership", () => {
  it("keeps claims for different action kinds independent", () => {
    const pin = ThreadUndo.begin("pin", "env/shared");
    const archive = ThreadUndo.begin("archive", "env/shared");
    ThreadUndo.invalidate("pin", "env/shared");
    expect(pin.isCurrent()).toBe(false);
    expect(archive.isCurrent()).toBe(true);
    archive.finish();
  });

  it("does not revive the first Undo after a later pin and unpin", () => {
    const firstUnpin = ThreadUndo.begin("pin", "env/thread");
    ThreadUndo.invalidate("pin", "env/thread");
    const secondUnpin = ThreadUndo.begin("pin", "env/thread");
    expect(firstUnpin.isCurrent()).toBe(false);
    expect(secondUnpin.isCurrent()).toBe(true);
    firstUnpin.finish();
    expect(secondUnpin.isCurrent()).toBe(true);
    secondUnpin.finish();
    expect(firstUnpin.isCurrent()).toBe(false);
  });

  it("rejects a late unpin completion after a newer pin started", () => {
    const pendingUnpin = ThreadUndo.begin("pin", "env/late");
    ThreadUndo.invalidate("pin", "env/late");
    expect(pendingUnpin.isCurrent()).toBe(false);
  });

  it("expires an Undo without invalidating another environment or thread", () => {
    const first = ThreadUndo.begin("pin", "one/thread");
    const otherEnvironment = ThreadUndo.begin("pin", "two/thread");
    const otherThread = ThreadUndo.begin("pin", "one/other");
    first.finish();
    expect(first.isCurrent()).toBe(false);
    expect(otherEnvironment.isCurrent()).toBe(true);
    expect(otherThread.isCurrent()).toBe(true);
    otherEnvironment.finish();
    otherThread.finish();
  });
});
