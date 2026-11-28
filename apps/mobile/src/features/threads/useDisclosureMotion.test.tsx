import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useDisclosureMotion } from "./useDisclosureMotion";

type Motion = { readonly playing: boolean };

function renderMotion(working: boolean) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  let motion!: ReturnType<typeof useDisclosureMotion<Motion>>;
  const Probe = (props: { working: boolean }) => {
    motion = useDisclosureMotion<Motion>(props.working);
    return null;
  };
  const render = (next: boolean) =>
    act(async () => root.render(createElement(Probe, { working: next })));
  return {
    render,
    current: () => motion,
    ready: render(working),
    unmount: () => act(async () => root.unmount()),
  };
}

/** Advances one 16 ms frame at a time, reporting a row size change on each, like a streaming turn. */
const streamFrames = (feed: ReturnType<typeof renderMotion>, frames: number) =>
  act(async () => {
    for (let frame = 0; frame < frames; frame++) {
      feed.current().onItemSizeChanged();
      vi.advanceTimersByTime(16);
    }
  });

describe("useDisclosureMotion", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
    });
  });
  afterEach(() => vi.useRealTimers());

  it("plays a hold within 100 ms even while rows resize every frame", async () => {
    const feed = renderMotion(false);
    await feed.ready;
    await act(async () => feed.current().hold({ playing: false }));
    await streamFrames(feed, 5);
    expect(feed.current().layout).toEqual({ playing: false });
    await streamFrames(feed, 2);
    expect(feed.current().layout).toEqual({ playing: true });
    await streamFrames(feed, 15);
    expect(feed.current().layout).toBeNull();
    await feed.unmount();
  });

  it("plays a hold two frames after rows stop resizing", async () => {
    const feed = renderMotion(false);
    await feed.ready;
    await act(async () => feed.current().hold({ playing: false }));
    await act(async () => vi.advanceTimersByTime(40));
    expect(feed.current().layout).toEqual({ playing: true });
    await feed.unmount();
  });

  it("plays a hold as soon as work starts", async () => {
    const feed = renderMotion(false);
    await feed.ready;
    await act(async () => feed.current().hold({ playing: false }));
    await feed.render(true);
    expect(feed.current().layout).toEqual({ playing: true });
    await feed.unmount();
  });
});
