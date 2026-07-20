import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(async (_tabId: string, _url: string): Promise<void> => undefined),
  rememberPreviewUrl: vi.fn(),
  readPreparedConnection: vi.fn(() => ({ httpBaseUrl: "http://172.25.85.75:3773" })),
  submittedUrl: null as ((url: string) => void) | null,
  emptyStateUrl: null as ((url: string) => void) | null,
  showEmptyState: false,
}));

vi.mock("~/state/session", () => ({
  readPreparedConnection: mocks.readPreparedConnection,
}));

vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (
    select: (store: { addPreviewAnnotation: () => void; addImage: () => void }) => unknown,
  ) => select({ addPreviewAnnotation: vi.fn(), addImage: vi.fn() }),
}));

vi.mock("~/lib/previewAnnotation", () => ({
  previewAnnotationScreenshotFile: vi.fn(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: vi.fn(),
}));

vi.mock("~/previewStateStore", () => ({
  rememberPreviewUrl: mocks.rememberPreviewUrl,
  updatePreviewServerSnapshot: vi.fn(),
  useThreadPreviewState: () => ({
    activeTabId: "tab-1",
    desktopByTabId: {
      "tab-1": {
        canGoBack: false,
        canGoForward: false,
        loading: false,
        zoomFactor: 1,
        controller: "none",
      },
    },
    recentlySeenUrls: [],
    sessions: mocks.showEmptyState
      ? {}
      : {
          "tab-1": {
            threadId: "thread-1",
            tabId: "tab-1",
            navStatus: {
              _tag: "Success",
              url: "http://example.com/",
              title: "Example",
            },
            canGoBack: false,
            canGoForward: false,
            updatedAt: "2026-07-13T00:00:00.000Z",
          },
        },
  }),
}));

vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({ label: "WSL" }),
  useEnvironmentHttpBaseUrl: () => "http://172.25.85.75:3773",
}));

vi.mock("~/state/preview", () => ({
  previewEnvironment: { open: {}, resize: {} },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

vi.mock("~/browser/browserRecording", () => ({
  startBrowserRecording: vi.fn(),
  stopBrowserRecording: vi.fn(),
  useActiveBrowserRecordingTabId: () => null,
}));

vi.mock("~/browser/browserSurfaceStore", () => ({
  useBrowserSurfaceStore: (
    select: (state: { byTabId: Record<string, { rect?: unknown }> }) => unknown,
  ) => select({ byTabId: {} }),
}));

vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: vi.fn(),
  toastManager: { add: vi.fn() },
}));

vi.mock("./previewBridge", () => ({
  previewBridge: { navigate: mocks.navigate },
}));

vi.mock("./PreviewChromeRow", () => ({
  PreviewChromeRow: (props: { onSubmit: (url: string) => void }) => {
    mocks.submittedUrl = props.onSubmit;
    return null;
  },
}));

vi.mock("./PreviewEmptyState", () => ({
  PreviewEmptyState: (props: { onOpenUrl: (url: string) => void }) => {
    mocks.emptyStateUrl = props.onOpenUrl;
    return null;
  },
}));
vi.mock("./PreviewMoreMenu", () => ({ PreviewMoreMenu: () => null }));
vi.mock("./PreviewUnreachable", () => ({ PreviewUnreachable: () => null }));
vi.mock("./ZoomIndicator", () => ({ ZoomIndicator: () => null }));
vi.mock("./AgentBrowserCursor", () => ({ AgentBrowserCursor: () => null }));
vi.mock("~/browser/BrowserSurfaceSlot", () => ({ BrowserSurfaceSlot: () => null }));
vi.mock("./useLoadingProgress", () => ({ useLoadingProgress: () => 0 }));
vi.mock("./usePreviewSession", () => ({ usePreviewSession: vi.fn() }));

import { PreviewView } from "./PreviewView";

describe("PreviewView navigation", () => {
  beforeEach(() => {
    mocks.navigate.mockClear();
    mocks.rememberPreviewUrl.mockClear();
    mocks.readPreparedConnection.mockClear();
    mocks.submittedUrl = null;
    mocks.emptyStateUrl = null;
    mocks.showEmptyState = false;
  });

  it.each([
    [
      "https://localhost:8000/dashboard?mode=test#top",
      "https://localhost:8000/dashboard?mode=test#top",
    ],
    ["localhost:5173/app", "http://localhost:5173/app"],
  ])("preserves a direct localhost URL in a WSL environment", async (submitted, expected) => {
    renderToStaticMarkup(
      <PreviewView
        threadRef={{
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
        }}
        tabId="tab-1"
        visible
      />,
    );

    expect(mocks.submittedUrl).not.toBeNull();
    mocks.submittedUrl?.(submitted);

    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("tab-1", expected));
    expect(mocks.rememberPreviewUrl).toHaveBeenCalledWith(
      {
        environmentId: "environment-1",
        threadId: "thread-1",
      },
      expected,
    );
  });

  it("maps an empty-state localhost server onto the WSL host", async () => {
    mocks.showEmptyState = true;
    renderToStaticMarkup(
      <PreviewView
        threadRef={{
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
        }}
        tabId="tab-1"
        visible
      />,
    );

    expect(mocks.emptyStateUrl).not.toBeNull();
    mocks.emptyStateUrl?.("http://localhost:5173/app?mode=test#top");

    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(
        "tab-1",
        "http://172.25.85.75:5173/app?mode=test#top",
      ),
    );
    expect(mocks.rememberPreviewUrl).toHaveBeenCalledWith(
      {
        environmentId: "environment-1",
        threadId: "thread-1",
      },
      "http://172.25.85.75:5173/app?mode=test#top",
    );
  });
});
