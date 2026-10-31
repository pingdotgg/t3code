import {
  DEFAULT_CLIENT_SETTINGS,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { type ClosedViewEntry, useClosedViewStore } from "./closedViewStore";
import { createLayoutState, selectFocusedTab, findLayoutTab } from "./layout/layoutModel";
import { useLayoutStore } from "./layout/layoutStore";
import { __setClientSettingsForTests } from "./hooks/useSettings";
import { readThreadPreviewState, resetPreviewStateForTests } from "./previewStateStore";
import { planNextReopen, type ReopenOwnerState, reopenClosedView } from "./reopenClosedView";
import {
  selectThreadRightPanelState,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};
const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "old-tab",
  navStatus: { _tag: "Success", url: "https://example.com", title: "Example" },
  canGoBack: false,
  canGoForward: false,
  viewport: { _tag: "freeform", width: 1200, height: 800 },
  profileId: "work",
  updatedAt: "2026-09-22T12:00:00.000Z",
};

beforeEach(() => {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  resetPreviewStateForTests();
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
});

describe("reopenClosedView", () => {
  it("restores a chat at its saved pane position without reopening it twice", async () => {
    const original = useLayoutStore.getState().layout;
    using _restore = { [Symbol.dispose]: () => useLayoutStore.setState({ layout: original }) };
    useLayoutStore.setState({ layout: createLayoutState() });
    const store = useLayoutStore.getState();
    store.openTab({ kind: "chat", target: { kind: "server", threadRef } });
    const tab = selectFocusedTab(useLayoutStore.getState().layout)!;
    const location = findLayoutTab(
      useLayoutStore.getState().layout,
      (candidate) => candidate.id === tab.id,
    )!;
    store.openTab(
      { kind: "launcher", id: "reopen-launcher", context: null },
      { placement: "active-pane" },
    );
    store.closeTab(tab.id);
    const entry = {
      kind: "chat",
      id: "closed-chat",
      threadRef,
      paneId: location.pane.id,
      index: 0,
    } as const;
    const owner: ReopenOwnerState = {
      environmentKnown: true,
      catalogReady: true,
      ownerExists: true,
      sideChatExists: true,
      shellLive: true,
      panel: { isOpen: false, activeSurfaceId: null, surfaces: [] },
    };
    expect(planNextReopen([entry], () => owner).restore).toBe(entry);
    const openPreview = vi.fn();
    expect(await reopenClosedView(entry, { openPreview, workspaceAvailable: false })).toBe(true);
    const restored = findLayoutTab(
      useLayoutStore.getState().layout,
      (candidate) => candidate.content.kind === "chat",
    )!;
    expect(restored.pane.id).toBe(location.pane.id);
    expect(restored.tabIndex).toBe(0);
    expect(selectFocusedTab(useLayoutStore.getState().layout)?.id).toBe(restored.tab.id);
    expect(planNextReopen([entry], () => owner)).toEqual({ drop: [entry], restore: null });
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("restores a file tab at its line without creating a browser session", async () => {
    const openPreview = vi.fn();
    const reopened = await reopenClosedView(
      {
        kind: "panel-tab",
        threadRef,
        surface: {
          kind: "file",
          id: "file:src/app.ts",
          relativePath: "src/app.ts",
          revealLine: 18,
          revealRequestId: 1,
        },
      },
      { openPreview, workspaceAvailable: true },
    );
    expect(reopened).toBe(true);
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
    expect(state.isOpen).toBe(true);
    expect(state.surfaces).toMatchObject([{ id: "file:src/app.ts", revealLine: 18 }]);
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("does not reopen workspace tabs without an available project", async () => {
    const options = {
      openPreview: vi.fn(),
      workspaceAvailable: false,
    };
    for (const surface of [
      { kind: "files", id: "files" },
      {
        kind: "file",
        id: "file:src/app.ts",
        relativePath: "src/app.ts",
        revealLine: null,
        revealRequestId: 0,
      },
    ] as const) {
      expect(await reopenClosedView({ kind: "panel-tab", threadRef, surface }, options)).toBe(
        false,
      );
    }
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toEqual([]);
  });

  it("recreates a browser tab with saved URL, viewport and profile, then selects its new ID", async () => {
    const openPreview = vi.fn(async () => AsyncResult.success({ ...snapshot, tabId: "new-tab" }));
    const result = await reopenClosedView(
      { kind: "browser", threadRef, snapshot },
      { openPreview, workspaceAvailable: false },
    );
    expect(result).toBe(true);
    expect(openPreview).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        url: "https://example.com",
        viewport: snapshot.viewport,
        profileId: "work",
      },
    });
    expect(readThreadPreviewState(threadRef).snapshot?.tabId).toBe("new-tab");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef)
        .activeSurfaceId,
    ).toBe("browser:new-tab");
  });

  it("leaves the panel unchanged when a browser resource fails to reopen", async () => {
    const result = await reopenClosedView(
      { kind: "browser", threadRef, snapshot },
      {
        openPreview: async () => AsyncResult.failure(Cause.fail(new Error("offline"))),
        workspaceAvailable: false,
      },
    );
    expect(result).toBe(false);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toEqual([]);
  });
});

describe("planNextReopen", () => {
  const entries: ClosedViewEntry[] = [
    { id: "a", kind: "panel-tab", threadRef, surface: { kind: "diff", id: "diff" } },
    { id: "b", kind: "panel-tab", threadRef, surface: { kind: "files", id: "files" } },
  ];
  const known: ReopenOwnerState = {
    environmentKnown: true,
    catalogReady: true,
    ownerExists: true,
    sideChatExists: true,
    shellLive: true,
    panel: { isOpen: false, activeSurfaceId: null, surfaces: [] },
  };
  const openDiff: ThreadRightPanelState = {
    isOpen: true,
    activeSurfaceId: "diff",
    surfaces: [{ kind: "diff", id: "diff" }],
  };

  it.each([
    ["restores the newest entry", [known, known], [], "a"],
    [
      "drops a removed environment once the catalog is ready",
      [{ ...known, environmentKnown: false }, known],
      ["a"],
      "b",
    ],
    [
      "waits for the catalog before dropping",
      [{ ...known, environmentKnown: false, catalogReady: false }, known],
      [],
      null,
    ],
    [
      "skips but keeps a thread deleted from a live shell",
      [{ ...known, ownerExists: false }, known],
      [],
      "b",
    ],
    [
      "skips but keeps a side chat deleted from a live shell",
      [{ ...known, sideChatExists: false }, known],
      [],
      "b",
    ],
    [
      "waits when a cached shell lacks the side chat",
      [{ ...known, sideChatExists: false, shellLive: false }, known],
      [],
      null,
    ],
    [
      "waits when a cached shell lacks the thread",
      [{ ...known, ownerExists: false, shellLive: false }, known],
      [],
      null,
    ],
    ["drops a tab that is already open", [{ ...known, panel: openDiff }, known], ["a"], "b"],
    [
      "restores a tab whose panel is hidden",
      [{ ...known, panel: { ...openDiff, isOpen: false } }],
      [],
      "a",
    ],
  ] as const)("%s", (_name, owners, dropped, restored) => {
    const plan = planNextReopen(
      entries.slice(0, owners.length),
      (e) => owners[entries.indexOf(e)]!,
    );
    expect(plan.drop.map((e) => e.id)).toEqual(dropped);
    expect(plan.restore?.id ?? null).toBe(restored);
  });
});
