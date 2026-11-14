import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
} from "@t3tools/contracts";
import { type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

import type { PreviewableServer } from "./useDiscoveredLocalServers";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(async (_tabId: string, _url: string): Promise<void> => undefined),
  rememberPreviewUrl: vi.fn(),
  readPreparedConnection: vi.fn(() => ({ httpBaseUrl: "http://172.25.85.75:3773" })),
  readEnvironmentScope: vi.fn((_environmentId?: unknown, _scope?: unknown) => true),
  setAnnotationSendEnabled: vi.fn(async (_tabId: string, _enabled: boolean): Promise<void> => {}),
  cancelPickElement: vi.fn(async (_tabId: string) => undefined),
  openPictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  closePictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  pickElement: vi.fn(),
  addPreviewAnnotation: vi.fn(),
  addImage: vi.fn(),
  pictureInPicture: false,
  showEmptyState: false,
  idleServerTab: false,
  loading: false,
  nativeServerTab: false,
  streamedServerTab: false,
  serverEpoch: null as string | null,
  servers: [] as PreviewableServer[],
  recordingTabIds: new Set<string>(),
  recordingRuntimeTabId: null as string | null,
  recordVisitForThread: vi.fn(),
}));

const STUB_BROWSER_DEFAULTS = {
  viewport: FILL_PREVIEW_VIEWPORT,
  zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR,
  appearance: DEFAULT_PREVIEW_APPEARANCE,
  autoShowFloatingPreview: true,
  profiles: BUILT_IN_BROWSER_PROFILES,
  profileId: DEFAULT_BROWSER_PROFILE_ID,
};

// The desktop bridge only exists inside Electron; the view reads it once at import.
vi.mock(import("./previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    navigate: mocks.navigate,
    pickElement: mocks.pickElement,
    annotationVoice: { onEvent: () => () => {}, update: async () => {} },
    setAnnotationSendEnabled: mocks.setAnnotationSendEnabled,
    cancelPickElement: mocks.cancelPickElement,
    refresh: vi.fn(async () => undefined),
    goBack: vi.fn(async () => undefined),
    goForward: vi.fn(async () => undefined),
    hardReload: vi.fn(async () => undefined),
    openDevTools: vi.fn(async () => undefined),
    setColorScheme: vi.fn(async () => undefined),
    zoomIn: vi.fn(async () => undefined),
    zoomOut: vi.fn(async () => undefined),
    resetZoom: vi.fn(async () => undefined),
    clearCookies: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    pictureInPicture: {
      open: mocks.openPictureInPicture,
      close: mocks.closePictureInPicture,
    },
    findInPage: vi.fn(async () => undefined),
    stopFindInPage: vi.fn(async () => undefined),
    onFindResult: vi.fn(() => () => undefined),
  } as never,
}));
vi.mock(import("~/browserHistoryStore"), async (original) => ({
  ...(await original()),
  recordVisitForThread: mocks.recordVisitForThread,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readPreparedConnection: mocks.readPreparedConnection as never,
  readEnvironmentScope: mocks.readEnvironmentScope,
  useEnvironmentScope: mocks.readEnvironmentScope,
}));
vi.mock(import("~/browser/browserDefaults"), async (original) => ({
  ...(await original()),
  useBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
  getBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
}));
vi.mock(import("~/previewStateStore"), async (original) => ({
  ...(await original()),
  rememberPreviewUrl: mocks.rememberPreviewUrl,
  useThreadPreviewState: (() => ({
    activeTabId: "tab-1",
    serverEpoch: mocks.serverEpoch,
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
      : mocks.idleServerTab
        ? {
            "tab-1": {
              threadId: "thread-1",
              tabId: "tab-1",
              runtime: "server",
              navStatus: { _tag: "Idle" },
              canGoBack: false,
              canGoForward: false,
              updatedAt: "2026-07-13T00:00:00.000Z",
            },
          }
        : {
            "tab-1": {
              threadId: "thread-1",
              tabId: "tab-1",
              runtime: mocks.nativeServerTab || mocks.streamedServerTab ? "server" : "desktop",
              navStatus: { _tag: "Success", url: "http://example.com/", title: "Example" },
              canGoBack: false,
              canGoForward: false,
              updatedAt: "2026-07-13T00:00:00.000Z",
            },
          },
  })) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => ({ label: "WSL" })) as never,
  useEnvironmentHttpBaseUrl: () => "http://172.25.85.75:3773",
  usePrimaryEnvironmentId: () => null,
}));
vi.mock(import("~/browser/browserRecording"), async (original) => ({
  ...(await original()),
  findActiveBrowserRecordingRuntimeTabId: () => mocks.recordingRuntimeTabId,
  useActiveBrowserRecordingTabIds: () => mocks.recordingTabIds,
}));
vi.mock(import("./useDiscoveredLocalServers"), async (original) => ({
  ...(await original()),
  useDiscoveredLocalServers: () => mocks.servers,
}));
vi.mock(import("./usePreviewSession"), async (original) => ({
  ...(await original()),
  usePreviewSession: () => {},
}));

vi.mock(import("~/browser/previewRuntime"), async (original) => ({
  ...(await original()),
  useRendersServerTabNatively: () => mocks.nativeServerTab,
}));

vi.mock(import("~/browser/browserViewportActions"), { spy: true });
// The real surface opens a preview stream to the server; only its box matters here.
vi.mock(import("~/browser/ServerBrowserSurface"), async (original) => ({
  ...(await original()),
  ServerBrowserSurface: ((props: { className?: string }) => (
    <div data-testid="server-browser-surface" className={props.className} />
  )) as never,
}));

import { useComposerDraftStore } from "~/composerDraftStore";
import { commitBrowserViewportChange } from "~/browser/browserViewportActions";
import { resolveResponsiveBrowserViewportSize } from "~/browser/browserViewportLayout";
import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayerTabId,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { dispatchPreviewAction } from "./previewActionBus";
import { PreviewView } from "./PreviewView";
import { ThreadPreviewMiniPlayer } from "./ThreadPreviewMiniPlayer";
import { ChatCanvas } from "../chat/ChatCanvas";
import { createChatCanvasStore } from "../chat/canvasStore";
import { shouldRenderPreviewMiniPlayer } from "../ChatView.logic";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import { closePreviewPanel } from "../chat/closePreviewPanel";
import { useRightPanelActions } from "../chat/useRightPanelActions";
import { __testing as previewStateTesting } from "~/previewStateStore";
import { ToastProvider } from "~/components/ui/toast";

const TEST_THREAD_REF = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;
const TEST_RUNTIME_TAB_ID = previewRuntimeTabId(TEST_THREAD_REF, null, "tab-1");

function view(onSendAnnotation?: ComponentProps<typeof PreviewView>["onSendAnnotation"]) {
  return (
    <PreviewView
      threadRef={TEST_THREAD_REF}
      tabId="tab-1"
      visible
      {...(onSendAnnotation ? { onSendAnnotation } : {})}
    />
  );
}

function PanelCloseAction() {
  const activeRightPanelSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, TEST_THREAD_REF),
  );
  const { closePreviewPanelStable } = useRightPanelActions({
    activeThreadRef: TEST_THREAD_REF,
    activeProject: null,
    activeRightPanelSurface,
    activePreviewState: previewStateTesting.EMPTY_THREAD_PREVIEW_STATE,
    deviceState: {} as Parameters<typeof useRightPanelActions>[0]["deviceState"],
    pullRequestPanelTarget: null,
    threadPanelPresentation: "inline",
    embedded: false,
    isServerThread: true,
    isGitRepo: false,
    browserAvailable: true,
    canOperatePreview: true,
    diffOpen: false,
    previewPanelOpen: true,
    rightPanelOpen: true,
    canMaximizeRightPanel: false,
    rightPanelMaximized: false,
    supportsPullRequests: false,
    pullRequestsSurfaceAvailable: false,
    gitCwd: null,
    activeProjectCwd: null,
    onDiffPanelOpen: undefined,
    closeRightPanelSurface: () => {},
  });
  return <button onClick={closePreviewPanelStable}>Close panel</button>;
}

function annotation(id: string, screenshot: unknown = null) {
  return {
    id,
    pageUrl: "https://example.com/dashboard",
    pageTitle: "Dashboard",
    comment: "Tighten this spacing",
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot,
    createdAt: "2026-07-27T00:00:00.000Z",
  };
}

// The mocked modules and stores are shared by the whole file, so every test starts by
// resetting them.
function setup() {
  vi.clearAllMocks();
  mocks.readEnvironmentScope.mockReset().mockReturnValue(true);
  mocks.setAnnotationSendEnabled.mockReset().mockResolvedValue(undefined);
  mocks.pickElement.mockReset();
  mocks.pictureInPicture = false;
  mocks.showEmptyState = false;
  mocks.idleServerTab = false;
  mocks.loading = false;
  mocks.nativeServerTab = false;
  mocks.streamedServerTab = false;
  mocks.serverEpoch = null;
  mocks.servers = [];
  mocks.recordingTabIds = new Set();
  mocks.recordingRuntimeTabId = null;
  useComposerDraftStore.setState({
    addPreviewAnnotation: mocks.addPreviewAnnotation,
    addImage: mocks.addImage,
  });
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useBrowserPointerStore.setState({ byTabId: {} });
}

describe("PreviewView", () => {
  it("does not restore a dismissed floating preview when the panel action closes", async () => {
    setup();
    useRightPanelStore.setState({ byThreadKey: {} });
    usePreviewMiniPlayerStore.getState().open(TEST_THREAD_REF, browserMiniPlayerSource("tab-1"));
    useRightPanelStore.getState().openBrowser(TEST_THREAD_REF, "tab-1");
    usePreviewMiniPlayerStore.getState().close(TEST_THREAD_REF);

    await using screen = await render(<PanelCloseAction />);
    await userEvent.click(screen.getByRole("button", { name: "Close panel" }));
    await vi.waitFor(() => {
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, TEST_THREAD_REF),
      ).toBeNull();
      expect(
        selectThreadPreviewMiniPlayerTabId(
          usePreviewMiniPlayerStore.getState().byThreadKey,
          TEST_THREAD_REF,
        ),
      ).toBeNull();
    });
  });

  it("returns to the same floating preview after docking and closing the panel", async () => {
    setup();
    useRightPanelStore.setState({ byThreadKey: {} });
    const store = usePreviewMiniPlayerStore.getState();
    store.open(TEST_THREAD_REF, browserMiniPlayerSource("tab-1"));
    store.resize(TEST_THREAD_REF, "browser:tab-1", 320, { x: 100, y: 150 });
    const miniPlayer = selectThreadPreviewMiniPlayer(
      usePreviewMiniPlayerStore.getState().byThreadKey,
      TEST_THREAD_REF,
    )!;
    const canvasStore = createChatCanvasStore();
    function FloatingPreviewHost() {
      const current = usePreviewMiniPlayerStore((state) =>
        selectThreadPreviewMiniPlayer(state.byThreadKey, TEST_THREAD_REF),
      );
      const surface = useRightPanelStore((state) =>
        selectActiveRightPanelSurface(state.byThreadKey, TEST_THREAD_REF),
      );
      if (!current || !shouldRenderPreviewMiniPlayer(current.source, surface)) return null;
      return (
        <ChatCanvas
          store={canvasStore}
          threadRef={TEST_THREAD_REF}
          preview={{
            key: "browser:tab-1",
            width: current.width,
            position: current.position,
            source: { width: 1024, height: 768 },
          }}
          composerOverlayElement={null}
        >
          <ThreadPreviewMiniPlayer threadRef={TEST_THREAD_REF} miniPlayer={current} />
        </ChatCanvas>
      );
    }
    await using screen = await render(
      <div className="flex w-[1000px] h-[700px]">
        <FloatingPreviewHost />
      </div>,
    );
    await userEvent.hover(
      screen
        .getByRole("region", { name: "Floating browser preview" })
        .element()
        .querySelector(".group")!,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open preview in right panel" }));
    await vi.waitFor(() => {
      const docked = selectThreadPreviewMiniPlayer(
        usePreviewMiniPlayerStore.getState().byThreadKey,
        TEST_THREAD_REF,
      );
      expect(docked).toEqual(miniPlayer);
      expect(
        shouldRenderPreviewMiniPlayer(
          docked?.source ?? null,
          selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, TEST_THREAD_REF),
        ),
      ).toBe(false);
    });
    await expect
      .element(screen.getByRole("region", { name: "Floating browser preview" }))
      .not.toBeInTheDocument();
    closePreviewPanel(TEST_THREAD_REF);
    await vi.waitFor(() => {
      const activeSurface = selectActiveRightPanelSurface(
        useRightPanelStore.getState().byThreadKey,
        TEST_THREAD_REF,
      );
      expect(activeSurface).toBeNull();
    });
    await vi.waitFor(() => {
      expect(
        shouldRenderPreviewMiniPlayer(
          selectThreadPreviewMiniPlayer(
            usePreviewMiniPlayerStore.getState().byThreadKey,
            TEST_THREAD_REF,
          )?.source ?? null,
          selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, TEST_THREAD_REF),
        ),
      ).toBe(true);
    });
    await expect
      .element(screen.getByRole("region", { name: "Floating browser preview" }))
      .toBeInTheDocument();
  });
  it.each(["mailto:alice@example.com", "http://"])(
    "reports rejected address %s without navigating or recording it",
    async (address) => {
      setup();
      await using _screen = await render(<ToastProvider timeout={0}>{view()}</ToastProvider>);
      const input = page.getByPlaceholder("Search or enter URL");
      await input.fill(address);
      await userEvent.keyboard("{Enter}");

      await expect.element(page.getByText("Could not open this address")).toBeVisible();
      await expect.element(page.getByText("Enter an http or https URL.")).toBeVisible();
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(mocks.recordVisitForThread).not.toHaveBeenCalled();
      await userEvent.click(page.getByRole("button", { name: "Dismiss notification" }));
    },
  );

  it("keeps the address in the bar when Enter commits an IME composition", async () => {
    setup();
    await using _screen = await render(view());
    const input = page.getByPlaceholder("Search or enter URL");
    await input.fill("https://example.com/pinyin");

    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(enter, "keyCode", { value: 229 });
    act(() => {
      input.element().dispatchEvent(enter);
    });

    await expect.element(input).toHaveFocus();
    await expect.element(input).toHaveValue("https://example.com/pinyin");
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(enter.defaultPrevented).toBe(true);
  });

  it("retains the annotation locally when its own environment loses access during capture", async () => {
    setup();
    const picked = annotation("annotation-revoked");
    const onSendAnnotation = vi.fn();
    let submitPick: (() => void) | undefined;
    mocks.pickElement.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          submitPick = () => resolve({ annotation: picked, submission: "send" });
        }),
    );
    await using screen = await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(submitPick).toBeDefined());
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, true);

    mocks.readEnvironmentScope.mockImplementation(
      (environmentId?: unknown) => environmentId !== TEST_THREAD_REF.environmentId,
    );
    await screen.rerender(view(onSendAnnotation));
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, false);
    await act(async () => submitPick!());
    await vi.waitFor(() =>
      expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, picked),
    );
    expect(onSendAnnotation).not.toHaveBeenCalled();

    mocks.readEnvironmentScope.mockReturnValue(true);
    mocks.pickElement.mockResolvedValue({ annotation: picked, submission: "send" });
    await screen.rerender(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(picked, null));
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, true);
  });

  it("still sends annotation text when the picked element's crop is malformed", async () => {
    setup();
    const picked = annotation("annotation-2", {
      dataUrl: "data:image/png;base64,%%%",
      width: 10,
      height: 10,
      cropRect: { x: 0, y: 0, width: 10, height: 10 },
    });
    const onSendAnnotation = vi.fn();
    mocks.pickElement.mockResolvedValue({ annotation: picked, submission: "send" });
    await using _screen = await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));

    const sent = { ...picked, screenshot: null };
    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(sent, null));
    expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, sent);
    expect(mocks.addImage).not.toHaveBeenCalled();
  });

  it("lets the pointer reach a local server card above an idle server-rendered tab", async () => {
    setup();
    mocks.idleServerTab = true;
    mocks.servers = [
      {
        host: "localhost",
        port: 8081,
        url: "http://localhost:8081/",
        requestedUrl: "http://localhost:8081/",
        processName: "python3",
        pid: 4242,
        terminal: null,
        source: "scanner",
      },
    ];
    await using _screen = await render(<ToastProvider timeout={0}>{view()}</ToastProvider>);
    const card = page.getByRole("button", { name: /localhost:8081/ });
    await expect.element(card).toBeVisible();

    const rect = card.element().getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    expect(card.element().contains(hit)).toBe(true);
  });

  it("sizes the first device viewport of a streamed tab to its panel", async () => {
    setup();
    mocks.streamedServerTab = true;
    await using _screen = await render(<ToastProvider timeout={0}>{view()}</ToastProvider>);
    const surface = page.getByTestId("server-browser-surface");
    await expect.element(surface).toBeInTheDocument();
    const rect = surface.element().getBoundingClientRect();

    await userEvent.click(page.getByRole("button", { name: "Preview menu" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Show device toolbar" }));

    expect(commitBrowserViewportChange).toHaveBeenCalledWith(expect.anything(), {
      _tag: "freeform",
      ...resolveResponsiveBrowserViewportSize(rect, 1),
    });
  });

  it("focuses and selects the address from forwarded desktop actions only while visible", async () => {
    setup();
    using stack = new DisposableStack();
    const previousBridge = window.desktopBridge;
    stack.defer(() => {
      if (previousBridge) window.desktopBridge = previousBridge;
      else delete window.desktopBridge;
    });
    const listeners = new Set<(action: string) => void>();
    window.desktopBridge = {
      getWindowZoomFactor: () => 1,
      onMenuAction: (listener: (action: string) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } as NonNullable<typeof window.desktopBridge>;
    await using screen = await render(view());
    const address = page.getByRole("textbox");
    const input = address.element() as HTMLInputElement;
    const forward = () =>
      act(() => {
        listeners.forEach((listener) => listener("preview.focusUrl"));
      });

    await forward();
    await expect.element(address).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    await act(() => input.blur());
    await forward();
    await expect.element(address).toHaveFocus();

    await act(() => input.blur());
    await screen.rerender(
      <PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible={false} />,
    );
    await forward();
    await expect.element(address).not.toHaveFocus();
    expect(listeners.size).toBe(0);
  });

  it("focuses the address bar each time the focus-url shortcut fires", async () => {
    setup();
    await using _screen = await render(view());
    const address = page.getByRole("textbox");

    act(() => dispatchPreviewAction("focus-url"));
    await expect.element(address).toHaveFocus();

    (address.element() as HTMLInputElement).blur();
    await expect.element(address).not.toHaveFocus();
    act(() => dispatchPreviewAction("focus-url"));
    await expect.element(address).toHaveFocus();
  });

  it("turns off the floating preview from the chrome picture-in-picture button", async () => {
    setup();
    usePreviewMiniPlayerStore.getState().open(TEST_THREAD_REF, browserMiniPlayerSource("tab-1"));
    await vi.waitFor(() => {
      expect(
        selectThreadPreviewMiniPlayerTabId(
          usePreviewMiniPlayerStore.getState().byThreadKey,
          TEST_THREAD_REF,
        ),
      ).toBe("tab-1");
    });

    await using _screen = await render(view());
    await userEvent.click(page.getByRole("button", { name: "Close floating preview" }));

    await vi.waitFor(() => {
      expect(
        selectThreadPreviewMiniPlayerTabId(
          usePreviewMiniPlayerStore.getState().byThreadKey,
          TEST_THREAD_REF,
        ),
      ).toBeNull();
    });
  });

  it("does not reopen find when the user returns to a tab they left with find open", async () => {
    setup();
    const tabView = (tabId: string) => (
      <PreviewView threadRef={TEST_THREAD_REF} tabId={tabId} visible />
    );
    await using screen = await render(tabView("tab-1"));
    const findBar = page.getByRole("search", { name: "Find in page" });

    act(() => dispatchPreviewAction("find"));
    await expect.element(findBar).toBeInTheDocument();

    await screen.rerender(tabView("tab-2"));
    await expect.element(findBar).not.toBeInTheDocument();
    await screen.rerender(tabView("tab-1"));
    await expect.element(findBar).not.toBeInTheDocument();
  });
});
