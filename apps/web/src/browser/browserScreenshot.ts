import { runBrowserViewportMutation } from "./browserViewportActions";

/** Capture at native scale while a still image keeps the fitted preview in place. */
export function captureBrowserScreenshot<T>(tabId: string, capture: () => Promise<T>): Promise<T> {
  return runBrowserViewportMutation(tabId, async () => {
    const webview = document.querySelector<HTMLElementTagNameMap["webview"]>(
      `webview[data-preview-tab="${CSS.escape(tabId)}"]`,
    );
    if (!webview || getComputedStyle(webview).transform === "none") return capture();

    const cover = document.createElement("img");
    const style = document.createElement("style");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let animationFrame = 0;
    const expired = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Browser screenshot preparation timed out.")),
        3_000,
      );
    });
    try {
      const frame = await Promise.race([webview.capturePage(), expired]);
      cover.src = frame.toDataURL();
      await Promise.race([cover.decode(), expired]);
      cover.alt = "";
      cover.className = webview.className;
      cover.style.cssText = webview.style.cssText;
      cover.style.position = "absolute";
      cover.style.zIndex = "1";
      cover.style.pointerEvents = "none";
      // An attribute override survives React updating the fitted viewport during capture.
      style.textContent = "webview[data-preview-native-capture] { transform: none !important; }";
      webview.after(cover, style);
      webview.setAttribute("data-preview-native-capture", "");
      await Promise.race([
        new Promise<void>((resolve) => {
          animationFrame = requestAnimationFrame(() => {
            animationFrame = requestAnimationFrame(() => resolve());
          });
        }),
        expired,
      ]);
      clearTimeout(timeout);
      return await capture();
    } finally {
      clearTimeout(timeout);
      cancelAnimationFrame(animationFrame);
      webview.removeAttribute("data-preview-native-capture");
      cover.remove();
      style.remove();
    }
  });
}
