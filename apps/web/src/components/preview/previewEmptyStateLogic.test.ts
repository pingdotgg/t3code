import type { PreviewSessionSnapshot, ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findDiscoveredServerTargetPort,
  getConfiguredPreviewUrls,
  shouldShowPreviewEmptyState,
} from "./previewEmptyStateLogic";
import type { PreviewableServer } from "./useDiscoveredLocalServers";

const snapshot = (navStatus: PreviewSessionSnapshot["navStatus"]): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId: "tab-1",
  navStatus,
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-12T20:00:00.000Z",
});

describe("shouldShowPreviewEmptyState", () => {
  it("shows quick-open options for a new idle browser tab", () => {
    expect(shouldShowPreviewEmptyState(snapshot({ _tag: "Idle" }))).toBe(true);
  });

  it("shows browser content once navigation starts", () => {
    expect(
      shouldShowPreviewEmptyState(
        snapshot({ _tag: "Loading", url: "http://localhost:5173", title: "" }),
      ),
    ).toBe(false);
  });
});

describe("getConfiguredPreviewUrls", () => {
  it("collects configured preview URLs from project scripts", () => {
    const scripts = [
      { previewUrl: "http://localhost:5173" },
      {},
      { previewUrl: "http://localhost:3000" },
    ] as ProjectScript[];

    expect(getConfiguredPreviewUrls(scripts)).toEqual([
      "http://localhost:5173",
      "http://localhost:3000",
    ]);
  });
});

describe("findDiscoveredServerTargetPort", () => {
  it("finds the listener port for a Portless history URL", () => {
    const server = {
      host: "localhost",
      port: 4058,
      url: "http://100.65.180.100:4058/",
      requestedUrl: "https://artelo.localhost",
      processName: "node",
      pid: 123,
      terminal: null,
      source: "scanner",
      listening: true,
    } satisfies PreviewableServer;

    expect(findDiscoveredServerTargetPort("https://artelo.localhost/", [server])).toBe(4058);
    expect(findDiscoveredServerTargetPort("https://other.localhost/", [server])).toBeUndefined();
  });
});
