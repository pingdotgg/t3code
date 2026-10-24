import { DESKTOP_PREVIEW_CAPTURE_SURFACE_TRIGGER } from "@t3tools/contracts";
import { flushSync } from "react-dom";

import { acquireBrowserSurfaceActivity } from "./browserSurfaceStore";

interface CaptureWebview extends HTMLElement {
  getWebContentsId(): number;
}

export function installBrowserCaptureSurface(): () => void {
  const leases = new Map<string, () => void>();
  const setSurface = async (webContentsId: number, captureId: string, active: boolean) => {
    if (!active) {
      flushSync(() => leases.get(captureId)?.());
      return true;
    }
    if (leases.has(captureId)) return false;
    const webview = [
      ...document.querySelectorAll<CaptureWebview>("webview[data-preview-tab]"),
    ].find((node) => {
      try {
        return node.getWebContentsId() === webContentsId;
      } catch {
        return false;
      }
    });
    const tabId = webview?.dataset.previewTab;
    const wrapper = webview?.closest<HTMLElement>("[data-preview-viewport]");
    if (!tabId || !wrapper) return false;

    let releaseActivity = () => {};
    flushSync(() => {
      releaseActivity = acquireBrowserSurfaceActivity(tabId);
    });
    return new Promise<boolean>((resolve) => {
      let frame: number;
      const release = () => {
        window.cancelAnimationFrame(frame);
        window.clearTimeout(timer);
        leases.delete(captureId);
        releaseActivity();
        resolve(false);
      };
      leases.set(captureId, release);
      // Two frames let Electron receive the committed guest bounds before CDP requests
      // a copy. A suspended embedder must fail readiness rather than leak the lease.
      frame = window.requestAnimationFrame(() => {
        wrapper.getBoundingClientRect();
        frame = window.requestAnimationFrame(() => {
          window.clearTimeout(timer);
          // A server timeout cannot cancel Chromium's copy request. Bound the rendering
          // lease too, so an abandoned screenshot cannot keep an inactive tab painting.
          timer = window.setTimeout(() => flushSync(release), 10_000);
          resolve(true);
        });
      });
      let timer = window.setTimeout(() => flushSync(release), 1_000);
    });
  };
  Object.defineProperty(globalThis, DESKTOP_PREVIEW_CAPTURE_SURFACE_TRIGGER, {
    configurable: true,
    value: setSurface,
  });
  return () => {
    for (const release of leases.values()) release();
    Reflect.deleteProperty(globalThis, DESKTOP_PREVIEW_CAPTURE_SURFACE_TRIGGER);
  };
}
