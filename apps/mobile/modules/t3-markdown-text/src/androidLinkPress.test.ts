import { describe, expect, it } from "vite-plus/test";

import {
  ANDROID_LINK_SELECTION_DRAG_SLOP_DP,
  androidLinkPressPoint,
  androidMarkdownLinkPressHandlers,
  type AndroidLinkGesture,
} from "./androidLinkPress";

function touch(pageX: number, pageY: number) {
  return { nativeEvent: { pageX, pageY, touches: [{ pageX, pageY }] } };
}

function release(pageX: number, pageY: number) {
  return { nativeEvent: { pageX, pageY, changedTouches: [{ pageX, pageY }] } };
}

describe("android markdown link press", () => {
  it("opens a tap and keeps a selection drag from opening the link", () => {
    const gesture: { current: AndroidLinkGesture | null } = { current: null };
    const opened: Array<"open"> = [];
    const handlers = androidMarkdownLinkPressHandlers(gesture, () => {
      opened.push("open");
    });

    handlers.onPressIn(touch(100, 200));
    handlers.onResponderMove(touch(104, 203));
    handlers.onPress(release(104, 203));
    expect(opened).toEqual(["open"]);

    handlers.onPressIn(touch(100, 200));
    handlers.onResponderMove(touch(100 + ANDROID_LINK_SELECTION_DRAG_SLOP_DP + 8, 200));
    handlers.onResponderMove(touch(100, 200));
    handlers.onPress(release(100, 200));
    expect(opened).toEqual(["open"]);

    handlers.onPressIn(touch(10, 20));
    handlers.onPress(release(10 + ANDROID_LINK_SELECTION_DRAG_SLOP_DP, 20));
    expect(opened).toEqual(["open", "open"]);

    handlers.onPressIn(touch(10, 20));
    handlers.onPress(release(10 + ANDROID_LINK_SELECTION_DRAG_SLOP_DP + 1, 20));
    expect(opened).toEqual(["open", "open"]);
  });

  it("still opens the next tap after a drag, and opens an accessibility activate", () => {
    const gesture: { current: AndroidLinkGesture | null } = { current: null };
    let opened = 0;
    const handlers = androidMarkdownLinkPressHandlers(gesture, () => {
      opened += 1;
    });

    handlers.onPressIn(touch(0, 0));
    handlers.onResponderMove(touch(40, 0));
    handlers.onPress(release(40, 0));
    expect(opened).toBe(0);

    handlers.onPressIn(touch(0, 0));
    handlers.onPress(release(2, 1));
    expect(opened).toBe(1);

    handlers.onPress({ nativeEvent: {} });
    expect(opened).toBe(2);
    expect(gesture.current).toBeNull();
  });

  it("reads the press point from the touch Pressability uses", () => {
    expect(
      androidLinkPressPoint({
        nativeEvent: { pageX: 9, pageY: 9, touches: [{ pageX: 1, pageY: 2 }] },
      }),
    ).toEqual({ pageX: 1, pageY: 2 });
    expect(
      androidLinkPressPoint({
        nativeEvent: { changedTouches: [{ pageX: 3, pageY: 4 }] },
      }),
    ).toEqual({ pageX: 3, pageY: 4 });
    expect(androidLinkPressPoint({ nativeEvent: { pageX: 5, pageY: 6 } })).toEqual({
      pageX: 5,
      pageY: 6,
    });
    expect(androidLinkPressPoint(undefined)).toBeNull();
    expect(androidLinkPressPoint({ nativeEvent: {} })).toBeNull();
  });
});
