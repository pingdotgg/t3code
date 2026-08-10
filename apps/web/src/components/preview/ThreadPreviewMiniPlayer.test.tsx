import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  miniPlayer: { tabId: "older-tab", position: null, size: null },
}));

vi.mock("~/browser/BrowserSurfaceSlot", () => ({
  BrowserSurfaceSlot: ({ tabId }: { tabId: string }) => <div data-browser-surface-tab-id={tabId} />,
}));

vi.mock("~/previewStateStore", () => ({
  useThreadPreviewState: () => ({
    activeTabId: "active-tab",
    serverEpoch: "epoch-1",
    desktopByTabId: {
      "active-tab": {},
      "older-tab": {},
    },
    sessions: {
      "active-tab": {},
      "older-tab": {},
    },
  }),
}));

vi.mock("./previewBridge", () => ({ previewBridge: null }));

vi.mock("~/previewMiniPlayerStore", () => ({
  selectThreadPreviewMiniPlayer: () => mocks.miniPlayer,
  usePreviewMiniPlayerStore: Object.assign(() => mocks.miniPlayer, {
    getState: () => ({ close: vi.fn(), move: vi.fn(), resize: vi.fn() }),
  }),
}));

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";

import { ThreadPreviewMiniPlayer } from "./ThreadPreviewMiniPlayer";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

describe("ThreadPreviewMiniPlayer", () => {
  it("renders the stored tab when it differs from the active preview tab", () => {
    const markup = renderToStaticMarkup(<ThreadPreviewMiniPlayer threadRef={threadRef} />);

    expect(markup).toContain("Floating browser preview");
    expect(markup).toContain(
      previewRuntimeTabId(threadRef, "epoch-1", "older-tab").replaceAll('"', "&quot;"),
    );
    expect(markup).toContain("Preview active");
    expect(markup).toContain("Open preview in panel");
    expect(markup).toContain("Resize floating preview");
    expect(markup).toContain("backdrop-blur-md");
    expect(markup).toContain("pointer-coarse:w-[84px]");
  });
});
