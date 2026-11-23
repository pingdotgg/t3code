import { EnvironmentId, type PreviewNavStatus, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";

vi.mock(import("~/state/preview"), () => ({ previewEnvironment: { open: Symbol("preview-open") } }));
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" as const, value: undefined }),
}));
vi.mock(import("~/state/device"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    deviceEnvironment: { list: "list", open: "open", close: "close", configure: "configure" },
    deviceHostProbeAtom: Atom.family(() => Atom.make(() => null)),
    NO_DEVICE_PROBE_ATOM: Atom.make(() => null),
    useDeviceState: () => ({ state: null, loaded: false }),
  };
});
vi.mock(import("~/components/chat/ChatOverlayHosts"), () => ({ openDeviceSetupDialog: vi.fn() }));
vi.mock(import("~/components/ui/toast"), () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: vi.fn(),
}));

import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import type { ThreadPreviewState } from "~/previewStateStore";

import { act, render } from "../../../test/render";
import { useRightPanelActions } from "./useRightPanelActions";

const threadRef = scopeThreadRef(EnvironmentId.make("env-close-panel"), ThreadId.make("thread"));

function previewState(navStatus: PreviewNavStatus): ThreadPreviewState {
  return {
    snapshot: null,
    sessions: {
      tab_a: {
        threadId: threadRef.threadId,
        tabId: "tab_a",
        navStatus,
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-11-24T00:00:00.000Z",
      },
    },
    suppressedTabIds: new Set<string>(),
    activeTabId: "tab_a",
    desktopOverlay: null,
    desktopByTabId: {},
    recentlySeenUrls: [],
    listLoaded: true,
    serverEpoch: null,
    serverRevision: 0,
  };
}

/** Renders the hook and hands back its close, the way the panel's close path calls it. */
async function closePanel(navStatus: PreviewNavStatus) {
  let close = () => {};
  function Harness() {
    close = useRightPanelActions({
      activeThreadRef: threadRef,
      activeProject: null,
      activeRightPanelSurface: { id: "browser:tab_a", kind: "preview", resourceId: "tab_a" },
      activePreviewState: previewState(navStatus),
      deviceState: null as never,
      deviceStateLoaded: false,
      pullRequestPanelTarget: null,
      threadPanelPresentation: "inline",
      isServerThread: false,
      embedded: false,
      diffAvailable: false,
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
      closeRightPanelSurface: vi.fn(),
    }).closePreviewPanelStable;
    return null;
  }
  await using _screen = await render(<Harness />);
  await act(() => close());
}

it("does not float a browser tab that never navigated", async () => {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  await closePanel({ _tag: "Idle" });

  expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({});
});

it("floats a browser tab that loaded a page", async () => {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  await closePanel({ _tag: "Success", url: "https://example.test/", title: "Example" });

  expect(Object.values(usePreviewMiniPlayerStore.getState().byThreadKey)).toMatchObject([
    { source: { kind: "browser", tabId: "tab_a" } },
  ]);
});
