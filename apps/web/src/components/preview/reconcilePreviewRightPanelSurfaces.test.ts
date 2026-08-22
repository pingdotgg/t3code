import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type PreviewSessionSnapshot, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import {
  openPreviewRightPanelSurface,
  reconcilePreviewRightPanelSurfaces,
} from "./reconcilePreviewRightPanelSurfaces";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));
const serverEpoch = "server-epoch";

const snapshot = (tabId: string): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: `2026-08-10T00:00:0${tabId.at(-1) ?? "0"}.000Z`,
});

beforeEach(() => {
  resetPreviewStateForTests();
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("reconcilePreviewRightPanelSurfaces", () => {
  it("registers automation tabs without forcing the panel open", () => {
    applyPreviewServerSnapshot(threadRef, snapshot("tab-2"));
    applyPreviewServerSnapshot(threadRef, snapshot("tab-3"));

    reconcilePreviewRightPanelSurfaces(threadRef);

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toEqual({
      isOpen: false,
      activeSurfaceId: "browser:tab-2",
      surfaces: [
        { id: "browser:tab-2", kind: "preview", resourceId: "tab-2" },
        { id: "browser:tab-3", kind: "preview", resourceId: "tab-3" },
      ],
    });
  });

  it("removes stale automation tabs after an authoritative session sync", () => {
    applyPreviewServerSnapshot(threadRef, snapshot("tab-2"));
    applyPreviewServerSnapshot(threadRef, snapshot("tab-3"));
    reconcilePreviewRightPanelSurfaces(threadRef);

    reconcilePreviewServerSessions(threadRef, {
      sessions: [snapshot("tab-3")],
      serverEpoch,
      revision: 1,
    });
    reconcilePreviewRightPanelSurfaces(threadRef);

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toEqual([{ id: "browser:tab-3", kind: "preview", resourceId: "tab-3" }]);
  });

  it("opens and activates the requested automation tab for the user", () => {
    applyPreviewServerSnapshot(threadRef, snapshot("tab-2"));
    applyPreviewServerSnapshot(threadRef, snapshot("tab-3"));

    openPreviewRightPanelSurface(threadRef, "tab-3");

    expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-3");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toEqual({
      isOpen: true,
      activeSurfaceId: "browser:tab-3",
      surfaces: [
        { id: "browser:tab-2", kind: "preview", resourceId: "tab-2" },
        { id: "browser:tab-3", kind: "preview", resourceId: "tab-3" },
      ],
    });
  });
});
