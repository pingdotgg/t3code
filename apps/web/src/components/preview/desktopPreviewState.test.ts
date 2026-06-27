import type { DesktopPreviewTabState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectDesktopPreviewState } from "./desktopPreviewState";

describe("projectDesktopPreviewState", () => {
  it("projects native readiness and interaction state for automation", () => {
    const state = {
      tabId: "tab_2",
      webContentsId: 42,
      navStatus: { kind: "Loading", url: "https://example.com", title: "Example" },
      canGoBack: true,
      canGoForward: false,
      zoomFactor: 0.8,
      focused: true,
      controller: "human",
      updatedAt: "2026-06-26T00:00:00.000Z",
    } satisfies DesktopPreviewTabState;

    expect(projectDesktopPreviewState(state)).toEqual({
      canGoBack: true,
      canGoForward: false,
      loading: true,
      zoomFactor: 0.8,
      focused: true,
      controller: "human",
    });
  });
});
