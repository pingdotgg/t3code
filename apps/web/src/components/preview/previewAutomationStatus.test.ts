import { describe, expect, it } from "vite-plus/test";

import { applyPreviewLoadFailureToAutomationStatus } from "./previewAutomationStatus";

const healthy = {
  available: true,
  visible: false,
  tabId: "tab_2",
  url: "http://localhost:5173/",
  title: "App",
  loading: false,
} as const;

describe("previewAutomationStatus", () => {
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

  it("keeps the requested URL when the guest landed on a chrome-error interstitial", () => {
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
      url: "http://localhost:5173/",
      title: "ERR_NAME_NOT_RESOLVED",
    });
  });

  it("does not let a stale LoadFailed snapshot override a live available guest", () => {
    expect(
      applyPreviewLoadFailureToAutomationStatus(
        healthy,
        {
          _tag: "LoadFailed",
          url: "http://localhost:5173/",
          title: "localhost:5173",
          code: -102,
          description: "ERR_CONNECTION_REFUSED",
        },
        { preferLiveAvailability: true },
      ),
    ).toEqual(healthy);
  });
});
