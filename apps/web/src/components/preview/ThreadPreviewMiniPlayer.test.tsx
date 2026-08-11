import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  miniPlayer: { tabId: "older-tab", position: null, size: null },
  viewport: { _tag: "fill" } as
    | { readonly _tag: "fill" }
    | { readonly _tag: "freeform"; readonly width: number; readonly height: number },
}));

vi.mock("~/browser/BrowserSurfaceSlot", () => ({
  BrowserSurfaceSlot: ({
    fitSourceContent,
    tabId,
  }: {
    fitSourceContent?: boolean;
    tabId: string;
  }) => (
    <div
      data-browser-surface-tab-id={tabId}
      data-fit-source-content={String(fitSourceContent ?? false)}
    />
  ),
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
      "older-tab": { viewport: mocks.viewport },
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

  it("resizes fill-mode content to the floating preview dimensions", () => {
    mocks.viewport = { _tag: "fill" };

    const markup = renderToStaticMarkup(<ThreadPreviewMiniPlayer threadRef={threadRef} />);

    expect(markup).toContain('data-fit-source-content="false"');
  });

  it("preserves explicitly selected fixed viewport dimensions", () => {
    mocks.viewport = { _tag: "freeform", width: 393, height: 852 };

    const markup = renderToStaticMarkup(<ThreadPreviewMiniPlayer threadRef={threadRef} />);

    expect(markup).toContain('data-fit-source-content="true"');
  });
});
