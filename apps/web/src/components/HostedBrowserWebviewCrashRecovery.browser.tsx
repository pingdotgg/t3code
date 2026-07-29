import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

const { previewConfig, setPreviewConfig } = vi.hoisted(() => {
  let previewConfig = {
    partition: "persist:preview",
    webPreferences: "contextIsolation=yes",
    preloadUrl: null,
  };
  return {
    previewConfig: () => previewConfig,
    setPreviewConfig: (nextConfig: typeof previewConfig) => {
      previewConfig = nextConfig;
    },
  };
});

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { registerWebview: vi.fn() },
}));

vi.mock("~/components/preview/usePreviewBridge", () => ({
  usePreviewBridge: vi.fn(),
}));

vi.mock("~/browser/browserRecording", () => ({
  stopBrowserRecording: vi.fn(async () => undefined),
  useActiveBrowserRecordingTabId: () => null,
}));

vi.mock("~/browser/browserSurfaceStore", () => ({
  resolveBrowserSurfacePanelRect: () => null,
  useBrowserSurfaceStore: Object.assign(() => ({ rect: null, visible: false }), {
    getState: () => ({ presentContent: vi.fn() }),
  }),
}));

vi.mock("~/browser/browserViewportLayout", () => ({
  browserViewportSettingKey: () => "fill",
}));

vi.mock("~/browser/BrowserDeviceToolbar", () => ({
  BrowserDeviceToolbar: () => null,
}));

vi.mock("~/browser/BrowserViewportResizeHandles", () => ({
  BrowserViewportResizeHandles: () => null,
}));

vi.mock("~/browser/desktopTabLifetime", () => ({
  acquireDesktopTab: () => ({ ready: Promise.resolve(), release: vi.fn() }),
}));

vi.mock("~/browser/hostedBrowserWebviewStyle", () => ({
  resolveHostedBrowserWebviewWrapperStyle: () => ({}),
}));

vi.mock("~/browser/previewWebviewConfigState", () => ({
  usePreviewWebviewConfig: () => previewConfig(),
}));

vi.mock("~/browser/useBrowserViewportResize", () => ({
  useBrowserViewportResize: () => ({
    activeDrag: null,
    commitViewportChange: vi.fn(),
    effectiveViewport: { _tag: "fill" },
    handleResizeKeyDown: vi.fn(),
    handleResizePointerDown: vi.fn(),
    layout: {
      canvasHeight: 800,
      canvasWidth: 1280,
      fillsPanel: true,
      viewportHeight: 800,
      viewportScale: 1,
      viewportWidth: 1280,
      viewportX: 0,
      viewportY: 0,
    },
  }),
}));

vi.mock("~/browser/webviewCrashRecovery", async () => {
  const actual = await vi.importActual<typeof import("~/browser/webviewCrashRecovery")>(
    "~/browser/webviewCrashRecovery",
  );
  return {
    ...actual,
    planWebviewCrashRecovery: () => ({
      delayMs: 0,
      state: { attempts: 1, windowStartedAt: 0 },
    }),
  };
});

import { HostedBrowserWebview } from "~/browser/HostedBrowserWebview";

const props = {
  threadRef: {
    environmentId: EnvironmentId.make("environment-id"),
    threadId: ThreadId.make("thread-id"),
  },
  tabId: "preview-tab",
  initialUrl: "https://example.com",
  viewport: { _tag: "fill" } as const,
  zoomFactor: 1,
};

it("keeps a scheduled crash recovery through preview config revalidation", async () => {
  const screen = await render(<HostedBrowserWebview {...props} />);

  try {
    const crashedWebview = document.querySelector("webview[data-preview-tab='preview-tab']");
    if (!(crashedWebview instanceof HTMLElement)) {
      throw new Error("Expected the preview webview to mount");
    }
    crashedWebview.dispatchEvent(new Event("render-process-gone"));

    setPreviewConfig({
      partition: "persist:preview-revalidated",
      webPreferences: "contextIsolation=yes",
      preloadUrl: null,
    });
    await screen.rerender(<HostedBrowserWebview {...props} zoomFactor={1.1} />);

    await expect
      .poll(() => document.querySelector("webview[data-preview-tab='preview-tab']"))
      .not.toBe(crashedWebview);
    const recoveredWebview = document.querySelector("webview[data-preview-tab='preview-tab']");
    expect(recoveredWebview).toHaveAttribute("src", "https://example.com");
  } finally {
    await screen.unmount();
  }
});
