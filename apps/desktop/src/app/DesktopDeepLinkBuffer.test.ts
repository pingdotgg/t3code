import { describe, expect, it, vi } from "vite-plus/test";

import { decodeDesktopDeepLinkTarget, makeDesktopDeepLinkBuffer } from "./DesktopDeepLinkBuffer.ts";

const target = {
  kind: "thread" as const,
  environmentId: "environment-1",
  threadId: "thread-1",
};

describe("DesktopDeepLinkBuffer", () => {
  it("replays the latest target received before the renderer subscribes", () => {
    const buffer = makeDesktopDeepLinkBuffer();
    buffer.push({ ...target, threadId: "stale" });
    buffer.push(target);
    const listener = vi.fn();

    buffer.subscribe(listener);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(target);
  });

  it("delivers later targets directly and stops after unsubscribe", () => {
    const buffer = makeDesktopDeepLinkBuffer();
    const listener = vi.fn();
    const unsubscribe = buffer.subscribe(listener);

    buffer.push(target);
    unsubscribe();
    buffer.push({ ...target, threadId: "later" });

    expect(listener).toHaveBeenCalledOnce();
  });

  it("rejects malformed renderer-bound targets", () => {
    expect(decodeDesktopDeepLinkTarget(target)).toEqual(target);
    expect(decodeDesktopDeepLinkTarget(null)).toBeNull();
    expect(decodeDesktopDeepLinkTarget({ ...target, threadId: 1 })).toBeNull();
    expect(decodeDesktopDeepLinkTarget({ ...target, kind: "project" })).toBeNull();
  });
});
