import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
} from "@t3tools/contracts";
import { act, createContext, useContext, Suspense } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { createExtensionHost } from "@t3tools/extension-sdk/host";
import type { ViewRecord } from "@t3tools/extension-sdk/contracts";
import { ExtensionSurface, type SurfaceRenderer } from "@t3tools/extension-sdk/react";
import { createBrowserExtension, type BrowserBindings } from "./browserExtension";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  supported: true,
  navigate: vi.fn(async (_tabId: string, _url: string): Promise<void> => undefined),
  rememberPreviewUrl: vi.fn(),
  readPreparedConnection: vi.fn(() => ({ httpBaseUrl: "http://172.25.85.75:3773" })),
  submittedUrl: null as ((url: string) => void) | null,
  emptyStateUrl: null as ((url: string) => void) | null,
  togglePictureInPicture: null as (() => void) | null,
  toggleNativePictureInPicture: null as (() => void) | null,
  pictureInPicturePressed: false,
  miniPlayerTabId: null as string | null,
  openMiniPlayer: vi.fn(),
  closeMiniPlayer: vi.fn(),
  closeRightPanel: vi.fn(),
  openPictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  closePictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  pickElement: vi.fn(),
  capturePreviewAnnotationScreenshot: vi.fn(),
  addPreviewAnnotation: vi.fn(),
  addImage: vi.fn(),
  toggleAnnotation: null as (() => void) | null,
  pictureInPicture: false,
  remoteLive: false,
  showEmptyState: false,
  loading: false,
  recordVisitForThread: vi.fn(),
}));

const EMPTY_HISTORY: never[] = [];

const STUB_BROWSER_DEFAULTS = {
  viewport: FILL_PREVIEW_VIEWPORT,
  zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR,
  appearance: DEFAULT_PREVIEW_APPEARANCE,
  autoShowFloatingPreview: true,
  profiles: BUILT_IN_BROWSER_PROFILES,
  profileId: DEFAULT_BROWSER_PROFILE_ID,
};

vi.mock("~/browserHistoryStore", () => ({
  recordVisitForThread: mocks.recordVisitForThread,
  setTitleForThreadUrl: vi.fn(),
  removeUrlForThread: vi.fn(),
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT: 50,
  useThreadRecentHistory: () => EMPTY_HISTORY,
}));

vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  readPreparedConnection: mocks.readPreparedConnection,
}));

// Stubbed at the direct dependency rather than letting the real module pull in
// `useSettings` -> `state/server`, which would drag the whole settings and
// connection graph into a test that only cares about the browser chrome.
vi.mock("~/browser/browserDefaults", () => ({
  useBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
  getBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
  browserDefaultOpenViewport: () => FILL_PREVIEW_VIEWPORT,
  browserDefaultOpenProfileId: () => DEFAULT_BROWSER_PROFILE_ID,
  browserDefaultTabState: () => ({
    zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR,
    colorScheme: DEFAULT_PREVIEW_APPEARANCE,
  }),
  browserResponsiveViewportForToggle: () => ({
    _tag: "freeform" as const,
    width: 1024,
    height: 768,
  }),
}));

vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (
    select: (store: { addPreviewAnnotation: () => void; addImage: () => void }) => unknown,
  ) =>
    select({
      addPreviewAnnotation: mocks.addPreviewAnnotation,
      addImage: mocks.addImage,
    }),
}));

vi.mock("~/lib/previewAnnotation", () => ({
  capturePreviewAnnotationScreenshot: mocks.capturePreviewAnnotationScreenshot,
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: vi.fn(),
}));

vi.mock("~/previewStateStore", () => ({
  isPreviewSupportedInRuntime: () => mocks.supported,
  rememberPreviewUrl: mocks.rememberPreviewUrl,
  updatePreviewServerSnapshot: vi.fn(),
  useThreadPreviewState: () => ({
    activeTabId: "tab-1",
    desktopByTabId: {
      "tab-1": {
        hasWebContents: true,
        canGoBack: false,
        canGoForward: false,
        loading: mocks.loading,
        zoomFactor: 1,
        pictureInPicture: mocks.pictureInPicture,
        colorScheme: "system",
        audioMuted: false,
        audible: false,
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
  findActiveBrowserRecordingRuntimeTabId: vi.fn(() => null),
  isBrowserRecordingStartCancelledError: vi.fn(() => false),
  startBrowserRecording: vi.fn(),
  stopBrowserRecording: vi.fn(),
  useActiveBrowserRecordingTabIds: () => new Set(),
}));

vi.mock("~/browser/browserSurfaceStore", () => ({
  useBrowserSurfaceStore: (
    select: (state: { byTabId: Record<string, { rect?: unknown }> }) => unknown,
  ) => select({ byTabId: {} }),
}));

vi.mock("~/previewMiniPlayerStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/previewMiniPlayerStore")>();
  const usePreviewMiniPlayerStore = Object.assign(
    (select: (state: unknown) => unknown) =>
      select({
        byThreadKey: mocks.miniPlayerTabId
          ? {
              "environment-1:thread-1": {
                source: actual.browserMiniPlayerSource(mocks.miniPlayerTabId),
                position: null,
                width: null,
              },
            }
          : {},
      }),
    {
      getState: () => ({
        open: mocks.openMiniPlayer,
        close: mocks.closeMiniPlayer,
      }),
    },
  );
  return { ...actual, usePreviewMiniPlayerStore };
});

vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ close: mocks.closeRightPanel }),
  },
}));

vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: vi.fn(),
  toastManager: { add: vi.fn() },
}));

vi.mock("../../components/preview/previewBridge", () => ({
  previewBridge: {
    navigate: mocks.navigate,
    pickElement: mocks.pickElement,
    pictureInPicture: {
      open: mocks.openPictureInPicture,
      close: mocks.closePictureInPicture,
    },
  },
}));

vi.mock("../../components/preview/PreviewChromeRow", () => ({
  PreviewChromeRow: (props: {
    onSubmit: (url: string) => void;
    onPickElement?: () => void;
    onPictureInPicture?: () => void;
    pictureInPicture?: boolean;
    trailingActions?: {
      props: { onNativePictureInPicture?: () => void };
    };
  }) => {
    mocks.submittedUrl = props.onSubmit;
    mocks.toggleAnnotation = props.onPickElement ?? null;
    mocks.togglePictureInPicture = props.onPictureInPicture ?? null;
    mocks.toggleNativePictureInPicture =
      props.trailingActions?.props.onNativePictureInPicture ?? null;
    mocks.pictureInPicturePressed = props.pictureInPicture ?? false;
    return null;
  },
}));

vi.mock("../../components/preview/PreviewEmptyState", () => ({
  PreviewEmptyState: (props: { onOpenUrl: (url: string) => void }) => {
    mocks.emptyStateUrl = props.onOpenUrl;
    return null;
  },
}));
vi.mock("../../components/preview/PreviewMoreMenu", () => ({
  PreviewMoreMenu: (props: { onNativePictureInPicture: () => void }) => {
    mocks.toggleNativePictureInPicture = props.onNativePictureInPicture;
    return null;
  },
}));
vi.mock("../../components/preview/PreviewUnreachable", () => ({ PreviewUnreachable: () => null }));
vi.mock("../../components/preview/ZoomIndicator", () => ({ ZoomIndicator: () => null }));
vi.mock("../../components/preview/AgentBrowserCursor", () => ({ AgentBrowserCursor: () => null }));
vi.mock("~/browser/BrowserSurfaceSlot", () => ({ BrowserSurfaceSlot: () => null }));
vi.mock("../../components/preview/usePreviewSession", () => ({ usePreviewSession: vi.fn() }));

import { PreviewPanel } from "../../components/preview/PreviewPanel";
import { usePreviewSession } from "../../components/preview/usePreviewSession";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";

const TEST_THREAD_REF = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;
const TEST_RUNTIME_TAB_ID = previewRuntimeTabId(TEST_THREAD_REF, null, "tab-1");

// These comparisons execute PreviewPanel and PreviewView, with the same domain/OS fixtures.
// They prove registration integration behavior, not Electron compositor or transport parity.
const BindingsContext = createContext<BrowserBindings | null>(null);
function useBindings() {
  const bindings = useContext(BindingsContext);
  if (!bindings) throw new Error("Missing Browser bindings");
  return bindings;
}
const record: ViewRecord = {
  version: 1,
  surfaceId: "t3.browser/view",
  context: {
    client: "desktop",
    resource: {
      namespace: "t3.browser",
      id: "tab-1",
      environmentId: "environment-1",
      projectId: "project-1",
      threadId: "thread-1",
    },
  },
  placement: "side-panel",
  stateVersion: 1,
  restoreState: null,
  fallback: "Browser unavailable",
};

async function mount(registered: boolean, overrides: Partial<BrowserBindings> = {}) {
  const bindings: BrowserBindings = {
    threadRef: TEST_THREAD_REF,
    tabId: "tab-1",
    visible: true,
    ...overrides,
  };
  const host = createExtensionHost<SurfaceRenderer>({ authorize: () => true });
  host.register(createBrowserExtension(useBindings));
  const id = await host.open(record);
  let tree!: ReactTestRenderer;
  const render = (next: BrowserBindings) => (
    <BindingsContext value={next}>
      {registered ? (
        <ExtensionSurface host={host} viewId={id} style={{ height: "100%", minHeight: 0 }} />
      ) : (
        <Suspense fallback={null}>
          <PreviewPanel {...next} mode="embedded" />
        </Suspense>
      )}
    </BindingsContext>
  );
  await act(async () => {
    tree = create(render(bindings));
  });
  return {
    host,
    id,
    tree,
    update: async (next: BrowserBindings) => {
      await act(async () => tree.update(render(next)));
    },
    close: async () => {
      await act(async () => {
        tree.unmount();
        host.dispose();
      });
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    innerWidth: 1280,
    addEventListener() {},
    removeEventListener() {},
    localStorage: { getItem: () => null },
  });
  vi.clearAllMocks();
  mocks.supported = true;
  mocks.showEmptyState = false;
  mocks.loading = false;
  mocks.miniPlayerTabId = null;
  mocks.pictureInPicture = false;
  mocks.pickElement.mockReset();
  mocks.capturePreviewAnnotationScreenshot.mockResolvedValue({ status: "none" });
});

afterEach(() => vi.unstubAllGlobals());

describe.each([false, true])("Browser composition registered=%s", (registered) => {
  it("normalizes navigation and records thread history through the existing engine", async () => {
    const view = await mount(registered);
    try {
      expect(mocks.submittedUrl).not.toBeNull();
      await act(async () => {
        mocks.submittedUrl!("localhost:5173/app");
      });
      expect(mocks.navigate).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID, "http://localhost:5173/app");
      expect(mocks.recordVisitForThread).toHaveBeenCalledWith(
        TEST_THREAD_REF,
        "http://localhost:5173/app",
      );
    } finally {
      await view.close();
    }
  });
  it("keeps failed navigation out of history and accepts a subsequent retry", async () => {
    const view = await mount(registered);
    try {
      mocks.navigate.mockRejectedValueOnce(new Error("disconnected"));
      await act(async () => {
        await mocks.submittedUrl!("localhost:5173/failed");
      });
      expect(mocks.recordVisitForThread).not.toHaveBeenCalled();
      expect(mocks.rememberPreviewUrl).not.toHaveBeenCalled();
      await act(async () => {
        await mocks.submittedUrl!("localhost:5173/retry");
      });
      expect(mocks.recordVisitForThread).toHaveBeenCalledWith(
        TEST_THREAD_REF,
        "http://localhost:5173/retry",
      );
    } finally {
      await view.close();
    }
  });
  it("resolves a discovered local server against the remote environment", async () => {
    mocks.showEmptyState = true;
    const view = await mount(registered);
    try {
      await act(async () => {
        mocks.emptyStateUrl!("http://localhost:5173/app");
      });
      expect(mocks.navigate).toHaveBeenCalledWith(
        TEST_RUNTIME_TAB_ID,
        "http://172.25.85.75:5173/app",
      );
      expect(mocks.recordVisitForThread).toHaveBeenCalledWith(
        TEST_THREAD_REF,
        "http://localhost:5173/app",
      );
    } finally {
      await view.close();
    }
  });
  it("opens and closes the floating preview without replacing the browser resource", async () => {
    const view = await mount(registered);
    try {
      await act(async () => mocks.togglePictureInPicture!());
      expect(mocks.openMiniPlayer).toHaveBeenCalledWith(TEST_THREAD_REF, {
        kind: "browser",
        tabId: "tab-1",
      });
      expect(mocks.closeRightPanel).toHaveBeenCalledWith(TEST_THREAD_REF);
      mocks.miniPlayerTabId = "tab-1";
      await view.update({ threadRef: TEST_THREAD_REF, tabId: "tab-1", visible: true });
      await act(async () => mocks.togglePictureInPicture!());
      expect(mocks.closeMiniPlayer).toHaveBeenCalledWith(TEST_THREAD_REF);
    } finally {
      await view.close();
    }
  });
  it("submits picked annotations through the host composer action", async () => {
    const annotation = {
      id: "annotation-1",
      pageUrl: "https://example.com/dashboard",
      pageTitle: "Dashboard",
      comment: "Tighten this spacing",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: "2026-07-27T00:00:00.000Z",
    };
    mocks.pickElement.mockResolvedValue({ annotation, submission: "send" });
    const onSendAnnotation = vi.fn();
    const view = await mount(registered, { onSendAnnotation });
    try {
      await act(async () => {
        mocks.toggleAnnotation!();
      });
      expect(onSendAnnotation).toHaveBeenCalledWith(annotation, null);
      expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, annotation);
    } finally {
      await view.close();
    }
  });
  it("preserves the desktop-only message on unsupported web runtimes", async () => {
    mocks.supported = false;
    const view = await mount(registered);
    try {
      expect(view.tree.root.findByType("p").children.join("")).toBe(
        "Preview is only available in the T3 Code desktop app.",
      );
      expect(usePreviewSession).not.toHaveBeenCalled();
    } finally {
      await view.close();
    }
  });
});

it("retains the native subtree and drains SDK viewers/listeners across 100 hide/show cycles", async () => {
  const view = await mount(true);
  const native = view.tree.root.findByType(PreviewPanel);
  try {
    for (let i = 0; i < 100; i++) {
      await act(async () => view.host.hide(view.id));
      expect(view.tree.root.findByType(PreviewPanel)).toBe(native);
      expect(native.props.visible).toBe(false);
      await act(async () => view.host.show(view.id));
      expect(view.tree.root.findByType(PreviewPanel)).toBe(native);
      expect(native.props.visible).toBe(true);
    }
    await view.update({ threadRef: TEST_THREAD_REF, tabId: "tab-1", visible: false });
    expect(native.props.visible).toBe(false);
    await act(async () => view.host.close(view.id));
    expect(view.tree.root.findAllByType(PreviewPanel)).toHaveLength(0);
  } finally {
    await view.close();
  }
  expect(view.host.diagnostics().listeners).toBe(0);
  expect(view.host.diagnostics().views).toBe(0);
});

it("restores host-owned tabs and rejects incompatible plugin restore payloads", async () => {
  const host = createExtensionHost<SurfaceRenderer>({ authorize: () => true });
  host.register(createBrowserExtension(useBindings));
  const restored = await host.open(record);
  expect(host.getSnapshot(restored)?.status).toBe("ready");
  const incompatible = await host.open({ ...record, restoreState: { tabId: "invented" } });
  expect(host.getSnapshot(incompatible)?.status).toBe("unavailable");
  host.dispose();
});

it("releases each SDK viewer over 100 open/hide/show/close cycles without creating browser sessions", async () => {
  const host = createExtensionHost<SurfaceRenderer>({ authorize: () => true });
  host.register(createBrowserExtension(useBindings));
  for (let i = 0; i < 100; i++) {
    const id = await host.open({
      ...record,
      context: { ...record.context, workspaceRevision: String(i) },
    });
    host.hide(id);
    await host.show(id);
    host.close(id);
    expect(host.diagnostics().views).toBe(0);
    expect(host.diagnostics().pendingCalls).toBe(0);
  }
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(usePreviewSession).not.toHaveBeenCalled();
  host.dispose();
});
