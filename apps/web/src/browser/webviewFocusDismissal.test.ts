import { describe, expect, it, vi } from "vite-plus/test";

import { subscribeWebviewFocusDismissal } from "./webviewFocusDismissal";

describe("subscribeWebviewFocusDismissal", () => {
  it("dismisses host popups when focus moves into the page, not when the host window refocuses it", () => {
    vi.useFakeTimers();
    const host = new EventTarget();
    const webview = new EventTarget();
    const dismiss = vi.fn();
    const unsubscribe = subscribeWebviewFocusDismissal(host, webview, dismiss);
    try {
      webview.dispatchEvent(new Event("focus"));
      expect(dismiss).toHaveBeenCalledOnce();

      host.dispatchEvent(new Event("focus"));
      webview.dispatchEvent(new Event("focus"));
      expect(dismiss).toHaveBeenCalledOnce();

      host.dispatchEvent(new Event("focus"));
      vi.runAllTimers();
      webview.dispatchEvent(new Event("focus"));
      expect(dismiss).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });
});
