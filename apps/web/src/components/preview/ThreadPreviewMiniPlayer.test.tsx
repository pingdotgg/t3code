// @vitest-environment jsdom

import {
  EnvironmentId,
  ThreadId,
  type DesktopPreviewBridge,
  type DesktopPreviewTabState,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import type { PreviewStreamControl } from "@t3tools/client-runtime/preview/server-browser-stream";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import {
  applyPreviewDesktopState,
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
  updatePreviewServerSnapshot,
} from "~/previewStateStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";

import { ChatCanvasContext } from "../chat/ChatCanvasContext";
import { resolveChatCanvasLayout } from "../chat/chatCanvasLayout";
import { ThreadPreviewMiniPlayer } from "./ThreadPreviewMiniPlayer";
import { projectDesktopState } from "./usePreviewBridge";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn<DesktopPreviewBridge["navigate"]>(),
  refresh: vi.fn<(tabId: string) => Promise<void>>(),
  closePictureInPicture: vi.fn<(tabId: string) => Promise<void>>(),
  toast: vi.fn(),
}));

vi.mock("./previewBridge", () => ({
  previewBridge: {
    navigate: mocks.navigate,
    refresh: mocks.refresh,
    pictureInPicture: { close: mocks.closePictureInPicture },
  },
}));
vi.mock("~/browser/browserRecording", () => ({
  findActiveBrowserRecordingRuntimeTabId: () => null,
  useActiveBrowserRecordingTabIds: () => new Set<string>(),
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openBrowser: vi.fn() }) },
}));
vi.mock("~/state/device", () => ({ useDeviceState: vi.fn() }));
vi.mock("../device/DeviceStreamView", () => ({ DeviceStreamView: () => null }));
vi.mock("~/state/previewStream", () => {
  const access = {
    httpBase: "http://preview.test/api/preview-stream",
    wsBase: "ws://preview.test/api/preview-stream",
    query: {},
    credentials: true,
  };
  return { usePreviewStreamAccess: () => access, refreshPreviewStreamAccess: vi.fn() };
});

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static current: FakeSocket;
  readyState = 1;
  binaryType = "";
  readonly sent: string[] = [];
  constructor(_url: string) {
    super();
    FakeSocket.current = this;
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  control(value: PreviewStreamControl) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify({ type: "control", ...value }) }),
    );
  }
}

const threadRef = {
  environmentId: EnvironmentId.make("mini-player-environment"),
  threadId: ThreadId.make("mini-player-thread"),
};
const tabId = "mini-player-tab";
const url = "http://localhost:5733/";
const previousUrl = "https://previous.example/";
const runtimeTabId = previewRuntimeTabId(threadRef, null, tabId);
const failure = {
  kind: "LoadFailed",
  url,
  title: "",
  code: -102,
  description: "ERR_CONNECTION_REFUSED",
} as const;
const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId,
  navStatus: { _tag: "Success", url: previousUrl, title: "Previous page" },
  viewport: { _tag: "freeform", width: 1280, height: 800 },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-10-06T00:00:00.000Z",
};
const canvas = {
  container: { width: 1200, height: 800 },
  lane: { padding: 20, minChatWidth: 640 },
  previewKey: `browser:${tabId}`,
  layout: resolveChatCanvasLayout({
    container: { width: 1200, height: 800 },
    preview: {
      key: `browser:${tabId}`,
      width: 320,
      position: null,
      source: { width: 1280, height: 800 },
    },
  }),
  reportPreview: vi.fn(),
  clearPreview: vi.fn(),
  registerTimeline: vi.fn(),
  reportDetailsCard: vi.fn(),
};

function desktopState(
  navStatus: DesktopPreviewTabState["navStatus"],
  overrides: Partial<DesktopPreviewTabState> = {},
) {
  applyPreviewDesktopState(
    threadRef,
    tabId,
    projectDesktopState({
      tabId: runtimeTabId,
      navStatus,
      webContentsId: 42,
      canGoBack: false,
      canGoForward: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      audioMuted: false,
      audible: false,
      controller: "none",
      updatedAt: snapshot.updatedAt,
      ...overrides,
    }),
  );
}

function Player() {
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef),
  );
  return miniPlayer ? (
    <ThreadPreviewMiniPlayer threadRef={threadRef} miniPlayer={miniPlayer} />
  ) : null;
}

let root: Root;
let container: HTMLDivElement;

function button(label: string) {
  const found = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === label || element.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.navigate.mockReset().mockResolvedValue(undefined);
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  mocks.closePictureInPicture.mockReset().mockResolvedValue(undefined);
  resetPreviewStateForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly onResize: () => void) {}
      observe() {
        this.onResize();
      }
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(868, 588, 320, 200),
  );
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  applyPreviewServerSnapshot(threadRef, snapshot);
  desktopState({ kind: "Success", url: previousUrl, title: "Previous page" });
  usePreviewMiniPlayerStore.getState().open(threadRef, browserMiniPlayerSource(tabId));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(() => {
    root.render(
      <AppAtomRegistryProvider>
        <ChatCanvasContext value={canvas}>
          <Player />
        </ChatCanvasContext>
      </AppAtomRegistryProvider>,
    );
  });
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  resetPreviewStateForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("floating browser navigation", () => {
  it("keeps a failed server stream connected so takeover can enable retry and success restores its canvas", async () => {
    vi.useFakeTimers();
    const serverSnapshot = {
      ...snapshot,
      runtime: "server" as const,
    };
    await act(() => updatePreviewServerSnapshot(threadRef, serverSnapshot));
    await act(() => vi.advanceTimersByTimeAsync(0));
    const socket = FakeSocket.current;
    const canvas = container.querySelector("canvas");
    await act(() =>
      updatePreviewServerSnapshot(threadRef, {
        ...serverSnapshot,
        navStatus: {
          _tag: "LoadFailed",
          url,
          title: "",
          code: failure.code,
          description: failure.description,
        },
      }),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Preview couldn't load",
    );
    expect(button("Retry").disabled).toBe(true);

    const control: PreviewStreamControl = {
      canOperate: true,
      controller: "agent",
      generation: 1,
      dialog: null,
    };
    await act(() => socket.control(control));
    await act(() => button("Retry").click());
    expect(socket.sent).toEqual([]);
    await act(() => button("Take control").click());
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([{ type: "takeControl" }]);
    await act(() => socket.control({ ...control, controller: "you", generation: 2 }));
    expect(button("Retry").disabled).toBe(false);
    await act(() => button("Retry").click());
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({ type: "navigate", url });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();

    await act(() =>
      updatePreviewServerSnapshot(threadRef, {
        ...serverSnapshot,
        navStatus: { _tag: "Loading", url, title: "" },
      }),
    );
    expect(container.textContent).toContain("Loading preview…");
    expect(socket.readyState).toBe(FakeSocket.OPEN);
    await act(() =>
      updatePreviewServerSnapshot(threadRef, {
        ...serverSnapshot,
        navStatus: { _tag: "Success", url, title: "App" },
      }),
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("canvas")).toBe(canvas);
    expect(FakeSocket.current).toBe(socket);
    expect(socket.readyState).toBe(FakeSocket.OPEN);
  });

  it("hides the failed guest, shows retry progress, and restores the same frame after success", async () => {
    const frameStyle = container.querySelector("section")?.getAttribute("style");
    expect(useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible).toBe(true);

    await act(() => desktopState(failure));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Preview couldn't load",
    );
    expect(container.textContent).toContain(url);
    expect(useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible).toBe(false);
    expect(button("Retry").disabled).toBe(false);
    expect(readThreadPreviewState(threadRef).sessions[tabId]?.navStatus).toMatchObject({
      url: previousUrl,
    });

    await act(() => {
      updatePreviewServerSnapshot(threadRef, {
        ...snapshot,
        navStatus: {
          _tag: "LoadFailed",
          url,
          title: "",
          code: -102,
          description: failure.description,
        },
      });
      button("Retry").click();
      desktopState({ kind: "Loading", url, title: "" });
    });
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(runtimeTabId, url);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading preview…");
    expect(useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible).toBe(false);

    await act(() => desktopState({ kind: "Success", url, title: "App" }));
    expect(readThreadPreviewState(threadRef).sessions[tabId]?.navStatus._tag).toBe("LoadFailed");
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible).toBe(true);
    expect(container.querySelector("section")?.getAttribute("style")).toBe(frameStyle);
  });

  it("publishes failures while the guest remains stopped and closes only the floating presentation", async () => {
    await act(() => desktopState(failure));
    await act(() => desktopState({ ...failure, description: "ERR_NAME_NOT_RESOLVED", code: -105 }));
    expect(container.textContent).toContain("DNS address could not be found");
    await act(() => button("Close").click());
    expect(container.querySelector("section")).toBeNull();
    expect(useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible).toBe(false);
    expect(readThreadPreviewState(threadRef).sessions[tabId]).toBeDefined();
  });

  it("keeps close available while reconnecting and reports a rejected retry", async () => {
    await act(() => desktopState(failure));
    mocks.navigate.mockRejectedValueOnce(new Error("Guest disconnected"));
    await act(() => button("Retry").click());
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Unable to retry preview",
        description: "Guest disconnected",
      }),
    );
    expect(useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible).toBe(false);

    await act(() => desktopState({ kind: "Idle" }, { webContentsId: null }));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Reconnecting preview…");
    await act(() => button("Close").click());
    expect(container.querySelector("section")).toBeNull();
  });

  it("allows an existing separate window to close during failed navigation", async () => {
    await act(() => desktopState(failure, { pictureInPicture: true }));
    expect(button("Close popped-out preview").disabled).toBe(false);
    await act(() => button("Close popped-out preview").click());
    expect(mocks.closePictureInPicture).toHaveBeenCalledExactlyOnceWith(runtimeTabId);
  });
});
