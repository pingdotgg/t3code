import { describe, expect, test } from "vite-plus/test";

import { getTimelinePageScrollKey } from "./pageScrollController";

describe("page scroll helpers", () => {
  const composerPageScrollEvent = (
    overrides: Partial<Parameters<typeof getTimelinePageScrollKey>[0]> = {},
  ) => ({
    altKey: false,
    clientHeight: 200,
    ctrlKey: false,
    defaultPrevented: false,
    isComposing: false,
    key: "PageDown",
    keyCode: 34,
    metaKey: false,
    scrollHeight: 200,
    scrollTop: 0,
    shiftKey: false,
    ...overrides,
  });

  test("leaves page keys to IME composition", () => {
    expect(getTimelinePageScrollKey(composerPageScrollEvent({ isComposing: true }))).toBeNull();
    expect(getTimelinePageScrollKey(composerPageScrollEvent({ keyCode: 229 }))).toBeNull();
  });

  test("leaves page keys to an overflowing composer until it reaches the boundary", () => {
    expect(
      getTimelinePageScrollKey(composerPageScrollEvent({ scrollHeight: 600, scrollTop: 0 })),
    ).toBeNull();
    expect(
      getTimelinePageScrollKey(
        composerPageScrollEvent({
          key: "PageUp",
          keyCode: 33,
          scrollHeight: 600,
          scrollTop: 400,
        }),
      ),
    ).toBeNull();

    expect(
      getTimelinePageScrollKey(
        composerPageScrollEvent({
          key: "PageUp",
          keyCode: 33,
          scrollHeight: 600,
          scrollTop: 0,
        }),
      ),
    ).toBe("PageUp");
    expect(
      getTimelinePageScrollKey(composerPageScrollEvent({ scrollHeight: 600, scrollTop: 400 })),
    ).toBe("PageDown");
  });

  test("hands off page keys within a fractional pixel of the composer boundary", () => {
    expect(
      getTimelinePageScrollKey(
        composerPageScrollEvent({
          key: "PageUp",
          keyCode: 33,
          scrollHeight: 600,
          scrollTop: 0.5,
        }),
      ),
    ).toBe("PageUp");
    expect(
      getTimelinePageScrollKey(composerPageScrollEvent({ scrollHeight: 600, scrollTop: 399.5 })),
    ).toBe("PageDown");
  });
});
