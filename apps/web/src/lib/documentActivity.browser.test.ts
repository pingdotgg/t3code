import { describe, expect, it, vi } from "vite-plus/test";

import { subscribeDocumentReturn } from "./documentActivity";

describe("subscribeDocumentReturn", () => {
  // Focus can come back from the preview iframe, and a quick alt-tab can miss
  // the blur, so a return must not depend on the cached activity flipping.
  it("fires on every window focus and every return to a visible tab", () => {
    using _focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    let visibility: DocumentVisibilityState = "visible";
    using _visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    const wake = vi.fn();
    using subscription = new DisposableStack();
    subscription.defer(subscribeDocumentReturn(wake));

    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    expect(wake).toHaveBeenCalledTimes(2);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(wake).toHaveBeenCalledTimes(2);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(wake).toHaveBeenCalledTimes(3);

    subscription.dispose();
    window.dispatchEvent(new Event("focus"));
    expect(wake).toHaveBeenCalledTimes(3);
  });
});
