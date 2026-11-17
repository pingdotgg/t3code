import { expect, it, vi } from "vite-plus/test";
import {
  executeReadyWebviewScript,
  isWebviewDomReady,
  onWebviewDomReady,
  trackWebviewDomReady,
} from "./webviewDomReady";

function guest() {
  return Object.assign(new EventTarget(), {
    isConnected: true,
    executeJavaScript: vi.fn(async (_code: string): Promise<unknown> => "ok"),
  });
}

it("notifies ready consumers after tracking, even when the host ref reattaches later", () => {
  const webview = guest();
  let stopTracking = trackWebviewDomReady(webview);
  const readiness: boolean[] = [];
  const stopListening = onWebviewDomReady(webview, () => {
    readiness.push(isWebviewDomReady(webview));
    void executeReadyWebviewScript(webview, "test");
  });

  stopTracking();
  stopTracking = trackWebviewDomReady(webview);
  webview.dispatchEvent(new Event("dom-ready"));
  expect(readiness).toEqual([true]);
  expect(webview.executeJavaScript).toHaveBeenCalledExactlyOnceWith("test");

  stopListening();
  stopTracking();
  stopTracking = trackWebviewDomReady(webview);
  webview.dispatchEvent(new Event("dom-ready"));
  expect(readiness).toEqual([true]);
  stopTracking();
});

it("resets readiness when the host ref changes and does not inherit another guest's readiness", async () => {
  const first = guest();
  const stop = trackWebviewDomReady(first);
  expect(await executeReadyWebviewScript(first, "test")).toBeUndefined();
  expect(first.executeJavaScript).not.toHaveBeenCalled();
  first.dispatchEvent(new Event("dom-ready"));
  expect(await executeReadyWebviewScript(first, "test")).toBe("ok");
  stop();
  expect(isWebviewDomReady(first)).toBe(false);
  first.dispatchEvent(new Event("dom-ready"));
  expect(isWebviewDomReady(first)).toBe(false);
  const second = guest();
  const stopSecond = trackWebviewDomReady(second);
  expect(isWebviewDomReady(second)).toBe(false);
  second.dispatchEvent(new Event("dom-ready"));
  expect(isWebviewDomReady(second)).toBe(true);
  stopSecond();
});

it("invalidates a detached or crashed guest until its own next dom-ready", async () => {
  const webview = guest();
  const stop = trackWebviewDomReady(webview);
  webview.dispatchEvent(new Event("dom-ready"));
  webview.isConnected = false;
  await executeReadyWebviewScript(webview, "test");
  expect(webview.executeJavaScript).not.toHaveBeenCalled();
  webview.isConnected = true;
  expect(isWebviewDomReady(webview)).toBe(false);
  webview.dispatchEvent(new Event("dom-ready"));
  expect(isWebviewDomReady(webview)).toBe(true);
  webview.dispatchEvent(new Event("render-process-gone"));
  expect(isWebviewDomReady(webview)).toBe(false);
  stop();
});

it("keeps same-document and subframe navigation ready", () => {
  const webview = guest();
  const stop = trackWebviewDomReady(webview);
  webview.dispatchEvent(new Event("dom-ready"));
  for (const details of [
    { isMainFrame: false, isInPlace: false },
    { isMainFrame: true, isInPlace: true },
  ]) {
    webview.dispatchEvent(Object.assign(new Event("did-start-navigation"), details));
    expect(isWebviewDomReady(webview)).toBe(true);
  }
  stop();
});
