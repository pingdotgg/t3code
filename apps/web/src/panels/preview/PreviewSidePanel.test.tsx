import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type PreviewAnnotationPayload,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { act, useEffect, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Drives the registered Preview through the real RegisteredSidePanel ->
// PreviewSidePanel -> PreviewView path. Only the desktop bridge, stores and
// leaf chrome are stubbed; the chrome row stub exposes the pick button.
const mocks = vi.hoisted(() => ({
  pickElement: vi.fn(),
  cancelPickElement: vi.fn(async (_runtimeTabId: string) => undefined),
  addPreviewAnnotation: vi.fn(),
  togglePick: null as (() => void) | null,
  pickActive: false,
  mounts: 0,
  disposals: 0,
}));

const BROWSER_DEFAULTS = {
  viewport: FILL_PREVIEW_VIEWPORT,
  zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR,
  appearance: DEFAULT_PREVIEW_APPEARANCE,
  autoShowFloatingPreview: true,
  profiles: BUILT_IN_BROWSER_PROFILES,
  profileId: DEFAULT_BROWSER_PROFILE_ID,
};

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { pickElement: mocks.pickElement, cancelPickElement: mocks.cancelPickElement },
}));
vi.mock("~/components/preview/usePreviewSession", () => ({
  // Lives exactly as long as the PreviewView instance, so it counts remounts.
  usePreviewSession: () => {
    useEffect(() => {
      mocks.mounts += 1;
      return () => {
        mocks.disposals += 1;
      };
    }, []);
  },
}));
vi.mock("~/components/preview/PreviewChromeRow", () => ({
  PreviewChromeRow: (props: { onPickElement?: () => void; pickActive?: boolean }) => {
    mocks.togglePick = props.onPickElement ?? null;
    mocks.pickActive = props.pickActive ?? false;
    return null;
  },
}));
vi.mock("~/components/preview/PreviewPanelShell", () => ({
  PreviewPanelShell: (props: { children: ReactNode }) => props.children,
}));
vi.mock("~/components/preview/PreviewEmptyState", () => ({ PreviewEmptyState: () => null }));
vi.mock("~/components/preview/PreviewMoreMenu", () => ({ PreviewMoreMenu: () => null }));
vi.mock("~/components/preview/PreviewUnreachable", () => ({ PreviewUnreachable: () => null }));
vi.mock("~/components/preview/ZoomIndicator", () => ({ ZoomIndicator: () => null }));
vi.mock("~/components/preview/AgentBrowserCursor", () => ({ AgentBrowserCursor: () => null }));
vi.mock("~/browser/BrowserSurfaceSlot", () => ({ BrowserSurfaceSlot: () => null }));
vi.mock("~/browser/browserSurfaceStore", () => ({
  useBrowserSurfaceStore: (select: (state: { byTabId: object }) => unknown) =>
    select({ byTabId: {} }),
}));
vi.mock("~/browser/browserDefaults", () => ({
  useBrowserDefaults: () => BROWSER_DEFAULTS,
  getBrowserDefaults: () => BROWSER_DEFAULTS,
  browserResponsiveViewportForToggle: () => FILL_PREVIEW_VIEWPORT,
}));
vi.mock("~/browser/browserRecording", () => ({
  findActiveBrowserRecordingRuntimeTabId: () => null,
  isBrowserRecordingStartCancelledError: () => false,
  startBrowserRecording: vi.fn(),
  stopBrowserRecording: vi.fn(),
  useActiveBrowserRecordingTabIds: () => new Set<string>(),
}));
vi.mock("~/browserHistoryStore", () => ({
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT: 50,
  recordVisitForThread: vi.fn(),
  removeUrlForThread: vi.fn(),
  setTitleForThreadUrl: vi.fn(),
  useThreadRecentHistory: () => [],
}));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: object) => unknown) =>
    select({ addPreviewAnnotation: mocks.addPreviewAnnotation, addImage: vi.fn() }),
}));
vi.mock("~/localApi", () => ({ ensureLocalApi: vi.fn() }));
vi.mock("~/previewStateStore", () => ({
  isPreviewSupportedInRuntime: () => true,
  rememberPreviewUrl: vi.fn(),
  updatePreviewServerSnapshot: vi.fn(),
  useThreadPreviewState: (threadRef: ScopedThreadRef) => ({
    activeTabId: "tab-1",
    serverEpoch: null,
    desktopByTabId: {},
    recentlySeenUrls: [],
    sessions: {
      "tab-1": {
        threadId: threadRef.threadId,
        tabId: "tab-1",
        navStatus: { _tag: "Success", url: "http://localhost:3000/", title: "App" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-10-04T00:00:00.000Z",
      },
    },
  }),
}));
vi.mock("~/previewMiniPlayerStore", () => ({
  browserMiniPlayerSource: (tabId: string) => ({ kind: "browser", tabId }),
  selectThreadPreviewMiniPlayerTabId: () => null,
  usePreviewMiniPlayerStore: Object.assign(
    (select: (state: { byThreadKey: object }) => unknown) => select({ byThreadKey: {} }),
    { getState: () => ({ open: vi.fn(), close: vi.fn() }) },
  ),
}));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ close: vi.fn() }) },
}));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({ label: "Local" }),
  useEnvironmentHttpBaseUrl: () => "http://localhost:3773",
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("~/state/preview", () => ({ previewEnvironment: { open: {}, resize: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
// This client holds every scope, so preview and annotation sends stay enabled.
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: vi.fn(),
  toastManager: { add: vi.fn() },
}));

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";

import { RegisteredSidePanel } from "../bundledPanels";
import { PanelHostContext, type PanelHost } from "../panelHost";

function thread(id: string): ScopedThreadRef {
  return { environmentId: EnvironmentId.make("environment-1"), threadId: ThreadId.make(id) };
}

function hostFor(threadRef: ScopedThreadRef): PanelHost {
  // A fresh closure per render, as ChatView lends it.
  return {
    threadRef,
    visible: true,
    composerDraftTarget: threadRef,
    workspaceMutationId: null,
    sendAnnotation: vi.fn(),
  };
}

function panel(host: PanelHost) {
  return (
    <PanelHostContext value={host}>
      <RegisteredSidePanel id="preview" tabId="tab-1" />
    </PanelHostContext>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const annotation: PreviewAnnotationPayload = {
  id: "annotation-1",
  pageUrl: "http://localhost:3000/",
  pageTitle: "App",
  comment: "Tighten this spacing",
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: null,
  createdAt: "2026-10-04T00:00:00.000Z",
};

describe("registered Preview side panel", () => {
  let renderer: ReactTestRenderer | null = null;

  // The registry loads the body lazily; warm the module so a render settles in one act.
  beforeAll(() => import("./PreviewSidePanel"));

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.pickElement.mockReset();
    mocks.cancelPickElement.mockClear();
    mocks.addPreviewAnnotation.mockClear();
    mocks.togglePick = null;
    mocks.pickActive = false;
    mocks.mounts = 0;
    mocks.disposals = 0;
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = null;
    vi.unstubAllGlobals();
  });

  async function render(host: PanelHost) {
    await act(async () => {
      if (renderer) renderer.update(panel(host));
      else renderer = create(panel(host));
    });
  }

  async function startPick() {
    const pick = deferred<{ annotation: PreviewAnnotationPayload; submission: "send" } | null>();
    mocks.pickElement.mockReturnValueOnce(pick.promise);
    await act(async () => mocks.togglePick?.());
    return pick;
  }

  it("keeps an in-flight pick across a same-thread host re-render", async () => {
    const threadA = thread("thread-a");
    const first = hostFor(threadA);
    await render(first);
    const pick = await startPick();
    expect(mocks.pickActive).toBe(true);

    const second = hostFor({ ...threadA });
    await render(second);
    expect(mocks).toMatchObject({ mounts: 1, disposals: 0, pickActive: true });
    expect(mocks.cancelPickElement).not.toHaveBeenCalled();

    await act(async () => pick.resolve({ annotation, submission: "send" }));
    expect(mocks.pickActive).toBe(false);
    // The pick reports to the render that started it, as before the registry.
    expect(first.sendAnnotation).toHaveBeenCalledWith(annotation, null);
    expect(second.sendAnnotation).not.toHaveBeenCalled();
    expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(threadA, annotation);
  });

  it("stays mounted across a thread switch and drops a pick that settles after it", async () => {
    const threadA = thread("thread-a");
    const threadB = thread("thread-b");
    const hostA = hostFor(threadA);
    await render(hostA);
    const pick = await startPick();
    expect(mocks.pickElement).toHaveBeenCalledWith(previewRuntimeTabId(threadA, null, "tab-1"));

    const hostB = hostFor(threadB);
    await render(hostB);
    expect(mocks).toMatchObject({ mounts: 1, disposals: 0, pickActive: false });
    // The old thread's picker is told to stop; the panel itself is not torn down.
    expect(mocks.cancelPickElement).toHaveBeenCalledWith(
      previewRuntimeTabId(threadA, null, "tab-1"),
    );

    // The switch cancelled the pick, so its late result reaches neither thread.
    await act(async () => pick.resolve({ annotation, submission: "send" }));
    expect(hostA.sendAnnotation).not.toHaveBeenCalled();
    expect(hostB.sendAnnotation).not.toHaveBeenCalled();
    expect(mocks.addPreviewAnnotation).not.toHaveBeenCalled();
    expect(mocks.disposals).toBe(0);
  });
});
