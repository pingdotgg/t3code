import { describe, expect, it } from "vite-plus/test";

import {
  applyPreviewLoadFailureToAutomationStatus,
  isChromeErrorPreviewUrl,
} from "./previewAutomationStatus";

const healthy = {
  available: true,
  visible: false,
  tabId: "tab_2",
  url: "http://localhost:5173/",
  title: "App",
  loading: false,
} as const;

describe("previewAutomationStatus", () => {
  it("detects chromium error interstitial URLs", () => {
    expect(isChromeErrorPreviewUrl("chrome-error://chromewebdata/")).toBe(true);
    expect(isChromeErrorPreviewUrl("http://localhost:5173/")).toBe(false);
    expect(isChromeErrorPreviewUrl(null)).toBe(false);
  });

  it("leaves a successful navigation unchanged", () => {
    expect(
      applyPreviewLoadFailureToAutomationStatus(healthy, {
        _tag: "Success",
        url: "http://localhost:5173/",
        title: "App",
      }),
    ).toEqual(healthy);
  });

  it("marks a failed navigation unavailable and reports the requested URL", () => {
    expect(
      applyPreviewLoadFailureToAutomationStatus(healthy, {
        _tag: "LoadFailed",
        url: "http://localhost:5173/",
        title: "localhost:5173",
        code: -102,
        description: "ERR_CONNECTION_REFUSED",
      }),
    ).toEqual({
      ...healthy,
      available: false,
      title: "ERR_CONNECTION_REFUSED",
    });
  });

  it("prefers the chrome-error interstitial when the guest already landed there", () => {
    expect(
      applyPreviewLoadFailureToAutomationStatus(
        { ...healthy, url: "chrome-error://chromewebdata/" },
        {
          _tag: "LoadFailed",
          url: "http://localhost:5173/",
          title: "localhost:5173",
          code: -105,
          description: "ERR_NAME_NOT_RESOLVED",
        },
      ),
    ).toEqual({
      ...healthy,
      available: false,
      url: "chrome-error://chromewebdata/",
      title: "ERR_NAME_NOT_RESOLVED",
    });
  });
});
