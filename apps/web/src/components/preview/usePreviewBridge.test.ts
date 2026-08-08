import type { DesktopPreviewTabState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { faviconRecordForDesktopState } from "./usePreviewBridge";

const PNG = "data:image/png;base64,AAAA";
const URL = "http://localhost:3000/app";
const ORIGIN = "http://localhost:3000";

function state(
  navStatus: DesktopPreviewTabState["navStatus"],
  overrides: Partial<DesktopPreviewTabState> = {},
): DesktopPreviewTabState {
  return {
    tabId: "tab-1",
    webContentsId: 1,
    navStatus,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    pictureInPicture: false,
    colorScheme: "system",
    controller: "none",
    favicon: PNG,
    faviconOrigin: ORIGIN,
    updatedAt: "2026-08-03T12:00:00.000Z",
    ...overrides,
  };
}

const recordKey = (url: string, favicon = PNG) => JSON.stringify([ORIGIN, url, favicon]);
const recorded = { dataUrl: PNG, key: recordKey(URL), url: URL };

describe("faviconRecordForDesktopState", () => {
  it("records the first matching favicon", () => {
    expect(
      faviconRecordForDesktopState({
        navigationPending: false,
        lastRecordedKey: null,
        state: state({ kind: "Success", url: URL, title: "App" }),
      }),
    ).toEqual(recorded);
  });

  it("ignores ordinary state changes carrying the same sticky favicon", () => {
    expect(
      faviconRecordForDesktopState({
        navigationPending: false,
        lastRecordedKey: recorded.key,
        state: state(
          { kind: "Success", url: URL, title: "Renamed" },
          { canGoBack: true, updatedAt: "2026-08-03T12:01:00.000Z" },
        ),
      }),
    ).toBeNull();
  });

  it("refreshes favicon recency when capture arrives after reload success", () => {
    const {
      favicon: _favicon,
      faviconOrigin: _faviconOrigin,
      ...successWithoutFavicon
    } = state({ kind: "Success", url: URL, title: "App" });
    expect(
      faviconRecordForDesktopState({
        navigationPending: true,
        lastRecordedKey: recorded.key,
        state: state({ kind: "Loading", url: URL, title: "App" }),
      }),
    ).toBeNull();
    expect(
      faviconRecordForDesktopState({
        navigationPending: true,
        lastRecordedKey: recorded.key,
        state: successWithoutFavicon,
      }),
    ).toBeNull();
    expect(
      faviconRecordForDesktopState({
        navigationPending: true,
        lastRecordedKey: recorded.key,
        state: state({ kind: "Success", url: URL, title: "App" }),
      }),
    ).toEqual(recorded);
  });

  it("records a changed favicon or a navigation within the same origin", () => {
    const nextUrl = `${ORIGIN}/settings`;
    expect(
      faviconRecordForDesktopState({
        navigationPending: false,
        lastRecordedKey: recorded.key,
        state: state({ kind: "Success", url: nextUrl, title: "Settings" }),
      }),
    ).toEqual({ dataUrl: PNG, key: recordKey(nextUrl), url: nextUrl });

    const nextIcon = "data:image/png;base64,BBBB";
    expect(
      faviconRecordForDesktopState({
        navigationPending: false,
        lastRecordedKey: recorded.key,
        state: state({ kind: "Success", url: URL, title: "App" }, { favicon: nextIcon }),
      }),
    ).toEqual({ dataUrl: nextIcon, key: recordKey(URL, nextIcon), url: URL });
  });

  it("rejects a sticky favicon from the previous origin", () => {
    expect(
      faviconRecordForDesktopState({
        navigationPending: true,
        lastRecordedKey: recorded.key,
        state: state({ kind: "Success", url: "https://example.com/", title: "Example" }),
      }),
    ).toBeNull();
  });
});
