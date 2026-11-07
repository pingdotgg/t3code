import { describe, expect, it, vi } from "vite-plus/test";

import { createOpenThreadSwipeable } from "./use-open-thread-swipeable";

describe("createOpenThreadSwipeable", () => {
  it("consumes an open swipe so the first tap only closes it", () => {
    const swipeable = createOpenThreadSwipeable();
    const close = vi.fn();

    swipeable.handleSwipeableWillOpen({ close } as never);
    expect(swipeable.consumeOpenSwipeable()).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(swipeable.consumeOpenSwipeable()).toBe(false);
  });

  it("closes the previous open swipe when another row opens", () => {
    const swipeable = createOpenThreadSwipeable();
    const firstClose = vi.fn();
    const secondClose = vi.fn();

    swipeable.handleSwipeableWillOpen({ close: firstClose } as never);
    swipeable.handleSwipeableWillOpen({ close: secondClose } as never);
    expect(firstClose).toHaveBeenCalledOnce();
    expect(swipeable.consumeOpenSwipeable()).toBe(true);
    expect(secondClose).toHaveBeenCalledOnce();
  });

  it("clears the open row when it closes itself", () => {
    const swipeable = createOpenThreadSwipeable();
    const methods = { close: vi.fn() } as never;

    swipeable.handleSwipeableWillOpen(methods);
    swipeable.handleSwipeableClose(methods);
    expect(swipeable.consumeOpenSwipeable()).toBe(false);
  });
});
