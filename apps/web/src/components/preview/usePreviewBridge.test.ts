import { EnvironmentId, ThreadId, type DesktopPreviewTabState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  mode: undefined as "native" | "headless" | undefined,
  listener: null as ((tabId: string, state: DesktopPreviewTabState) => void) | null,
  applyDesktopState: vi.fn(),
  unsubscribe: vi.fn(),
  reportStatus: vi.fn(),
  clearPointer: vi.fn(),
}));

vi.mock("~/previewStateStore", () => ({
  applyPreviewDesktopState: mocks.applyDesktopState,
  readThreadPreviewState: () => ({ sessions: { "tab-1": { serverPageMode: mocks.mode } } }),
}));
vi.mock("~/browserFaviconStore", () => ({
  flushPendingFaviconsForThread: vi.fn(),
  recordFaviconForThread: vi.fn(),
  useFaviconProjectRefForThread: () => null,
}));
vi.mock("~/browser/browserPointerStore", () => ({
  useBrowserPointerStore: (select: (state: { clear: typeof mocks.clearPointer }) => unknown) =>
    select({ clear: mocks.clearPointer }),
}));
vi.mock("~/state/preview", () => ({ previewEnvironment: { reportStatus: {} } }));
vi.mock("~/state/session", () => ({ usePreparedConnection: () => Option.none() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.reportStatus }));
vi.mock("./previewBridge", () => ({
  previewBridge: {
    onStateChange: (listener: typeof mocks.listener) => {
      mocks.listener = listener;
      return mocks.unsubscribe;
    },
  },
}));

import { projectDesktopState, usePreviewBridge } from "./usePreviewBridge";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
let renderer: ReactTestRenderer | undefined;

function BridgeHarness() {
  usePreviewBridge({ threadRef, tabId: "tab-1", runtimeTabId: "native-tab-1", serverDriven: true });
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mode = undefined;
  mocks.listener = null;
  vi.stubGlobal("window", {});
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const favicon = {
  dataUrl: "data:image/png;base64,AAAA",
  pageUrl: "http://localhost:3000/app",
  capturedAt: 1,
};

function state(navStatus: DesktopPreviewTabState["navStatus"]): DesktopPreviewTabState {
  return {
    tabId: "tab-1",
    webContentsId: 1,
    navStatus,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    pictureInPicture: false,
    colorScheme: "system",
    audioMuted: false,
    audible: false,
    controller: "none",
    favicon,
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

describe("projectDesktopState", () => {
  it("shows a retained icon only while the current document has the captured origin", () => {
    expect(
      projectDesktopState(
        state({ kind: "Loading", url: "http://localhost:3000/reload", title: "" }),
      ).favicon,
    ).toEqual(favicon);
    expect(
      projectDesktopState(
        state({
          kind: "LoadFailed",
          url: "https://example.com/",
          title: "",
          code: -105,
          description: "failed",
        }),
      ).favicon,
    ).toBeNull();
    expect(projectDesktopState(state({ kind: "Idle" })).favicon).toBeNull();
  });
});

describe("native bridge lifetime", () => {
  it("drops late native state when the server switches this tab to headless", async () => {
    mocks.mode = "native";
    await act(() => {
      renderer = create(createElement(BridgeHarness));
    });
    mocks.listener?.(
      "native-tab-1",
      state({ kind: "Loading", url: "https://example.com/", title: "" }),
    );
    expect(mocks.applyDesktopState).toHaveBeenLastCalledWith(
      threadRef,
      "tab-1",
      expect.objectContaining({ loading: true }),
    );
    expect(mocks.reportStatus).not.toHaveBeenCalled();

    mocks.mode = "headless";
    mocks.listener?.(
      "native-tab-1",
      state({ kind: "Success", url: "https://other.example/", title: "Late" }),
    );
    expect(mocks.applyDesktopState).toHaveBeenLastCalledWith(threadRef, "tab-1", null);
    expect(mocks.reportStatus).not.toHaveBeenCalled();

    await act(() => renderer?.unmount());
    renderer = undefined;
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.applyDesktopState).toHaveBeenLastCalledWith(threadRef, "tab-1", null);
  });

  it("clears the native overlay on headless unmount even without another native event", async () => {
    await act(() => {
      renderer = create(createElement(BridgeHarness));
    });
    mocks.listener?.(
      "native-tab-1",
      state({ kind: "Loading", url: "https://example.com/", title: "" }),
    );
    mocks.mode = "headless";
    await act(() => renderer?.unmount());
    renderer = undefined;
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.applyDesktopState).toHaveBeenLastCalledWith(threadRef, "tab-1", null);
  });
});
