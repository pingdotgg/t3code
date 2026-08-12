import { describe, expect, it, vi } from "vite-plus/test";

import { notifyContextMenuClosed, subscribeContextMenuClosed } from "./contextMenuLifetime";

describe("context menu lifetime", () => {
  it("notifies subscribers when a context menu closes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeContextMenuClosed(listener);

    notifyContextMenuClosed();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    notifyContextMenuClosed();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
