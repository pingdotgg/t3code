import type {
  DeviceServiceState,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: { getClientSettings: async () => null, setClientSettings: async () => {} },
  }),
}));

import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { ensureClientSettingsHydrated } from "~/hooks/useSettings";
import { useAgentOpenedPreviews } from "./useAgentOpenedPreviews";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-watcher"),
  threadId: ThreadId.make("thread-watcher"),
};
const deviceState = {
  hosts: [],
  hostStatus: "disconnected",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: "",
  revision: 0,
} satisfies DeviceServiceState;
const opener = {
  threadId: threadRef.threadId,
  tabId: "opener",
  navStatus: { _tag: "Loading", url: "about:blank", title: "" },
  canGoBack: false,
  canGoForward: false,
  runtime: "server",
  reveal: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies PreviewSessionSnapshot;
const popup = {
  threadId: opener.threadId,
  tabId: "popup",
  navStatus: opener.navStatus,
  canGoBack: false,
  canGoForward: false,
  runtime: "server",
  automationOwner: "agent-a",
  updatedAt: opener.updatedAt,
} satisfies PreviewSessionSnapshot;

let root: Root;

function Probe({ sessions }: { sessions: Record<string, PreviewSessionSnapshot> }) {
  useAgentOpenedPreviews({
    threadRef,
    deviceState,
    deviceStateLoaded: true,
    previewState: {
      snapshot: null,
      sessions,
      suppressedTabIds: new Set(),
      activeTabId: null,
      desktopOverlay: null,
      desktopByTabId: {},
      recentlySeenUrls: [],
      listLoaded: true,
      serverEpoch: "server-a",
      serverRevision: 1,
    },
    serverBrowserAvailable: true,
    panelSurfaces: [],
    miniPlayerSource: null,
    sheetLayout: false,
  });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await ensureClientSettingsHydrated();
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(() => root.unmount());
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  vi.unstubAllGlobals();
});

describe("useAgentOpenedPreviews", () => {
  it("does not float a watcher popup whose server snapshot omits reveal", async () => {
    await act(() => root.render(<Probe sessions={{ opener }} />));
    await act(() => root.render(<Probe sessions={{ opener, popup }} />));

    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({});
  });
});
