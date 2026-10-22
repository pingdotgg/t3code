import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useClosedViewStore } from "./closedViewStore";
import { reopenClosedView } from "./reopenClosedView";
import {
  migratePersistedRightPanelState,
  pullRequestSurface,
  pullRequestSurfaceId,
  registerEmbeddedPanelHost,
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectThreadPanelVisibility,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

beforeEach(() => {
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
});

async function reloadRightPanelStore() {
  const { storage, name } = useRightPanelStore.persist.getOptions();
  const persisted = await storage!.getItem(name!);
  expect(persisted).not.toBeNull();
  useRightPanelStore.setState(useRightPanelStore.getInitialState());
  await storage!.setItem(name!, persisted!);
  await useRightPanelStore.persist.rehydrate();
  expect(useRightPanelStore.persist.hasHydrated()).toBe(true);
}

describe("rightPanelStore", () => {
  it("records single and bulk tab closes, newest first", () => {
    const store = useRightPanelStore.getState();
    const pr = pullRequestSurface({
      projectId: "project-a",
      repository: "pingdotgg/t3code",
      number: 42,
    });
    store.openFile(refA, "src/app.ts");
    store.open(refA, "device");
    store.openPullRequest(refA, pr);
    store.open(refA, "diff");
    store.closeSurface(refA, pr.id);
    store.closeSurfacesToRight(refA, "device");
    store.closeOtherSurfaces(refA, "file:src/app.ts");
    expect(
      useClosedViewStore
        .getState()
        .entries.map((entry) => (entry.kind === "panel-tab" ? entry.surface.id : null)),
    ).toEqual(["device", "diff", pr.id]);
  });

  it("reopens the active tab first after a bulk close", () => {
    const store = useRightPanelStore.getState();
    store.open(refA, "files");
    store.open(refA, "diff");
    store.open(refA, "device");
    store.activateSurface(refA, "diff");
    store.closeAllSurfaces(refA);

    expect(
      useClosedViewStore
        .getState()
        .entries.map((entry) => entry.kind === "panel-tab" && entry.surface.id),
    ).toEqual(["diff", "device", "files"]);
  });

  it("does not save an incidental Files replacement when opening an existing file", () => {
    const store = useRightPanelStore.getState();
    store.openFile(refA, "src/app.ts");
    store.open(refA, "files");
    store.openFile(refA, "src/app.ts");

    expect(useClosedViewStore.getState().entries).toEqual([]);
  });

  it("ignores session tabs without browser snapshots and records the empty browser tab", () => {
    const store = useRightPanelStore.getState();
    store.openBrowser(refA, "tab-1");
    store.closeSurface(refA, "browser:tab-1");
    expect(useClosedViewStore.getState().entries).toEqual([]);
    store.openBrowser(refA, null);
    store.closeSurface(refA, "browser:new");
    expect(useClosedViewStore.getState().entries).toMatchObject([
      { kind: "panel-tab", surface: { id: "browser:new", resourceId: null } },
    ]);
  });

  it("keeps a dismissed device hidden after another file opens", () => {
    const store = useRightPanelStore.getState();
    const device = {
      hostId: "nucbox",
      deviceId: "emulator-5580",
      name: "Pixel",
      platform: "android",
    } as const;
    store.openFile(refA, "src/app.ts");
    store.closeSurface(refA, "file:src/app.ts");
    store.openDevice(refA, device);
    store.closeSurface(refA, "device:nucbox:emulator-5580");

    store.openFile(refA, "src/app.ts");
    store.openDevice(refA, device, true);

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toEqual([expect.objectContaining({ id: "file:src/app.ts" })]);
  });

  it("records only closed tabs when a panel is hidden or a terminal tab closes", () => {
    const store = useRightPanelStore.getState();
    store.open(refA, "diff");
    store.openFile(refA, "src/app.ts");
    store.closeSurface(refA, "file:src/app.ts");
    store.close(refA);
    expect(useClosedViewStore.getState().entries).toMatchObject([
      { kind: "panel-tab", threadRef: refA, surface: { id: "file:src/app.ts" } },
    ]);
    store.toggleVisibility(refA);
    store.toggle(refA, "diff");
    store.openTerminal(refA, "term-1");
    store.closeSurface(refA, "terminal:term-1");
    expect(useClosedViewStore.getState().entries).toMatchObject([
      { kind: "panel-tab", threadRef: refA, surface: { id: "file:src/app.ts" } },
    ]);
    expect(useClosedViewStore.getState().entries).toHaveLength(1);
  });

  it("opens a mounted side chat's files in its parent's panel, and its own once unmounted", () => {
    const store = useRightPanelStore.getState();
    const unregister = registerEmbeddedPanelHost(refB, refA, () => undefined);
    store.openFile(refB, "src/app.ts");
    const surfaceIds = (ref: typeof refA) =>
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces.map(
        (surface) => surface.id,
      );
    expect(surfaceIds(refA)).toEqual(["file:src/app.ts"]);
    expect(surfaceIds(refB)).toEqual([]);

    unregister();
    store.openFile(refB, "src/other.ts");
    expect(surfaceIds(refB)).toEqual(["file:src/other.ts"]);
  });

  it("opens a mounted side chat as a full thread only for user opens in its own panel", () => {
    const store = useRightPanelStore.getState();
    const opened = vi.fn();
    const unregister = registerEmbeddedPanelHost(refB, refA, opened);
    store.openBrowser(refB, "tab-1");
    // Already selected, as when the session event lands before the user's open.
    store.openBrowser(refB, "tab-1");
    expect(opened).toHaveBeenCalledTimes(2);

    opened.mockClear();
    store.activateSurface(refB, "browser:tab-1");
    store.openDevice(
      refB,
      { hostId: "host", deviceId: "device", platform: "ios", name: "iPhone" },
      true,
    );
    store.openFile(refB, "src/app.ts");
    expect(opened).not.toHaveBeenCalled();
    unregister();
  });

  it("restores a mounted side chat's file into its own panel when asked", () => {
    const store = useRightPanelStore.getState();
    const unregister = registerEmbeddedPanelHost(refB, refA, () => undefined);
    store.openFile(refB, "src/app.ts", undefined, { inOwnPanel: true });
    const surfaceIds = (ref: typeof refA) =>
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces.map(
        (surface) => surface.id,
      );
    expect(surfaceIds(refB)).toEqual(["file:src/app.ts"]);
    expect(surfaceIds(refA)).toEqual([]);
    unregister();
  });

  it("keeps several side chats open as peer tabs and reloads only well-formed ones", () => {
    const store = useRightPanelStore.getState();
    store.openAside(refA, "side-1");
    store.openAside(refA, "side-2");
    store.openAside(refA, "side-1");
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual(["aside:side-1", "aside:side-2"]);
    expect(state.isOpen).toBe(true);
    expect(state.activeSurfaceId).toBe("aside:side-1");

    const migrated = migratePersistedRightPanelState({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "aside:side-1",
          surfaces: [
            { id: "aside:side-1", kind: "aside", threadId: "side-1" },
            { id: "aside:broken", kind: "aside" },
          ],
        },
      },
    });
    expect(migrated.byThreadKey["env-1:thread-A"]?.surfaces).toEqual([
      { id: "aside:side-1", kind: "aside", threadId: "side-1" },
    ]);
  });

  it("gives each host/device its own tab and preserves renamed tabs", () => {
    const store = useRightPanelStore.getState();
    const android = {
      hostId: "nucbox",
      deviceId: "emulator-5580",
      name: "Pixel",
      platform: "android",
    } as const;
    const ios = { hostId: "macmini", deviceId: "ios-1", name: "iPhone", platform: "ios" } as const;
    store.open(refA, "device");
    store.openDevice(refA, android);
    store.open(refA, "device");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toHaveLength(2);
    store.openDevice(refA, ios);
    let state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      "device:nucbox:emulator-5580",
      "device:macmini:ios-1",
    ]);
    store.renameDevice(refA, "device:nucbox:emulator-5580", "Android test");
    store.openDevice(refA, android);
    state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces).toHaveLength(2);
    expect(state.surfaces[0]).toMatchObject({ title: "Android test", target: android });
    expect(state.activeSurfaceId).toBe("device:nucbox:emulator-5580");
    store.closeSurface(refA, state.activeSurfaceId!);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toEqual([expect.objectContaining({ target: ios })]);
  });

  it("does not collide when two hosts expose the same device id", () => {
    const store = useRightPanelStore.getState();
    const device = { deviceId: "emulator-5554", name: "Pixel", platform: "android" } as const;
    store.openDevice(refA, { ...device, hostId: "a:b" });
    store.openDevice(refA, { ...device, hostId: "a" });
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toHaveLength(2);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refB).surfaces,
    ).toHaveLength(0);
  });

  it.each(["one", "all", "others", "right"])(
    "keeps device tabs dismissed across reload after closing %s",
    (mode) => {
      const store = useRightPanelStore.getState();
      const target = {
        hostId: "nucbox",
        deviceId: "emulator-5580",
        name: "Pixel",
        platform: "android",
      } as const;
      store.open(refA, "files");
      store.openDevice(refA, target);
      if (mode === "one") store.closeSurface(refA, "device:nucbox:emulator-5580");
      if (mode === "all") store.closeAllSurfaces(refA);
      if (mode === "others") store.closeOtherSurfaces(refA, "files");
      if (mode === "right") store.closeSurfacesToRight(refA, "files");
      const persisted = JSON.parse(
        JSON.stringify({ byThreadKey: useRightPanelStore.getState().byThreadKey }),
      );
      useRightPanelStore.setState(migratePersistedRightPanelState(persisted));
      store.openDevice(refA, target, true);
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.some(
          (surface) => surface.kind === "device",
        ),
      ).toBe(false);
      store.openDevice(refA, target);
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.some(
          (surface) => surface.kind === "device",
        ),
      ).toBe(true);
    },
  );

  const completedDiff = { kind: "diff", turnId: RunId.make("turn-1") } as const;
  const linkedPullRequest = pullRequestSurface({
    projectId: "project-a",
    repository: "pingdotgg/t3code",
    number: 42,
  });

  it.each([
    { order: "diff-first", surface: linkedPullRequest },
    { order: "pull-request-first", surface: linkedPullRequest },
    { order: "diff-first", surface: { id: "pull-requests", kind: "pull-requests" } as const },
    {
      order: "pull-request-first",
      surface: { id: "pull-requests", kind: "pull-requests" } as const,
    },
  ])(
    "prioritizes $surface.kind over browser and diff with $order delivery",
    ({ order, surface }) => {
      const store = useRightPanelStore.getState();
      store.openBrowser(refA, "existing-browser");
      const revision = store.getUserActionRevision(refA);
      const requests = order === "diff-first" ? [completedDiff, surface] : [surface, completedDiff];
      for (const surface of requests) store.openProactive(refA, surface, revision);
      store.reconcileBrowserSurfaces(refA, ["existing-browser", "agent-browser"]);

      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA),
      ).toEqual(surface);

      store.open(refA, "diff");
      expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("diff");
    },
  );

  it.each([
    { choice: "file", choose: () => useRightPanelStore.getState().openFile(refA, "src/app.ts") },
    {
      choice: "pull request",
      choose: () =>
        useRightPanelStore.getState().openPullRequest(refA, { ...linkedPullRequest, number: 41 }),
    },
    { choice: "browser", choose: () => useRightPanelStore.getState().openBrowser(refA, "tab-a") },
    {
      choice: "terminal",
      choose: () => useRightPanelStore.getState().openTerminal(refA, "term-1"),
    },
    {
      choice: "same tab",
      choose: () => useRightPanelStore.getState().activateSurface(refA, "diff"),
    },
    { choice: "hide", choose: () => useRightPanelStore.getState().close(refA) },
    { choice: "toggle", choose: () => useRightPanelStore.getState().toggle(refA, "diff") },
    { choice: "close all", choose: () => useRightPanelStore.getState().closeAllSurfaces(refA) },
    {
      choice: "terminal close",
      choose: () => {
        const store = useRightPanelStore.getState();
        store.openTerminal(refA, "term-1");
        store.closeTerminal(refA, "terminal:term-1", "term-1");
      },
    },
  ])("keeps a later $choice choice when automatic requests arrive", ({ choose }) => {
    const store = useRightPanelStore.getState();
    store.open(refA, "diff");
    const revision = store.getUserActionRevision(refA);
    choose();
    const chosen = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);

    expect(store.openProactive(refA, completedDiff, revision)).toBe(false);
    expect(store.openProactive(refA, linkedPullRequest, revision)).toBe(false);
    expect(
      store.openProactive(refA, { id: "pull-requests", kind: "pull-requests" }, revision),
    ).toBe(false);
    const { isOpen, activeSurfaceId, surfaces } = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      refA,
    );
    expect({ isOpen, activeSurfaceId, surfaces }).toEqual({
      isOpen: chosen.isOpen,
      activeSurfaceId: chosen.activeSurfaceId,
      surfaces: chosen.surfaces,
    });
  });

  it.each([
    {
      surface: linkedPullRequest,
      choose: () => useRightPanelStore.getState().openFile(refA, "notes.md"),
    },
    {
      surface: { id: "pull-requests", kind: "pull-requests" } as const,
      choose: () => useRightPanelStore.getState().openBrowser(refA, "tab-a"),
    },
  ])(
    "preserves the selected tab and hidden panel when $surface.kind already exists",
    ({ surface, choose }) => {
      const store = useRightPanelStore.getState();
      store.openProactive(refA, surface, store.getUserActionRevision(refA));
      choose();
      const chosen = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);

      // Re-entry captures a fresh revision; the existing tab must still preserve the choice.
      expect(store.openProactive(refA, surface, store.getUserActionRevision(refA))).toBe(false);
      expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual(
        chosen,
      );

      store.close(refA);
      expect(store.openProactive(refA, surface, store.getUserActionRevision(refA))).toBe(false);
      expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
        ...chosen,
        isOpen: false,
      });
    },
  );

  it("retargets an existing PR tab but respects a later manual choice", () => {
    const store = useRightPanelStore.getState();
    const relinkedPullRequest = pullRequestSurface({ ...linkedPullRequest, number: 43 });
    store.openPullRequest(refA, relinkedPullRequest);
    store.openPullRequest(refA, linkedPullRequest);
    const revision = store.getUserActionRevision(refA);

    expect(store.openProactive(refA, relinkedPullRequest, revision, true)).toBe(true);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual(
      relinkedPullRequest,
    );

    store.close(refA);
    expect(store.openProactive(refA, linkedPullRequest, revision, true)).toBe(false);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA),
    ).toMatchObject({
      activeSurfaceId: relinkedPullRequest.id,
      isOpen: false,
    });
  });

  it("refocuses an existing diff for a later turn after a manual choice", () => {
    const store = useRightPanelStore.getState();
    store.openProactive(refA, completedDiff, store.getUserActionRevision(refA));
    const firstTurnRevision = store.getUserActionRevision(refA);
    store.openFile(refA, "src/app.ts");
    expect(store.openProactive(refA, completedDiff, firstTurnRevision)).toBe(false);

    const nextTurnRevision = store.getUserActionRevision(refA);
    expect(
      store.openProactive(
        refA,
        { ...completedDiff, turnId: RunId.make("turn-2") },
        nextTurnRevision,
      ),
    ).toBe(true);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("diff");
  });

  it("offers each completed diff once across dismissal, panel changes, and reload", async () => {
    const store = useRightPanelStore.getState();
    expect(store.openProactive(refA, completedDiff, store.getUserActionRevision(refA))).toBe(true);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("diff");

    store.close(refA);
    await reloadRightPanelStore();
    expect(store.openProactive(refA, completedDiff, store.getUserActionRevision(refA))).toBe(false);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();

    store.open(refA, "files");
    store.openFile(refA, "src/app.ts");
    await reloadRightPanelStore();
    expect(store.openProactive(refA, completedDiff, store.getUserActionRevision(refA))).toBe(false);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("file");

    store.closeAllSurfaces(refA);
    await reloadRightPanelStore();
    expect(store.openProactive(refA, completedDiff, store.getUserActionRevision(refA))).toBe(false);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();

    const otherEnvironment = scopeThreadRef("env-2" as EnvironmentId, refA.threadId);
    for (const ref of [refB, otherEnvironment]) {
      expect(store.openProactive(ref, completedDiff, store.getUserActionRevision(ref))).toBe(true);
      expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, ref)).toBe("diff");
    }

    const nextTurn = { ...completedDiff, turnId: RunId.make("turn-2") };
    expect(store.openProactive(refA, nextTurn, store.getUserActionRevision(refA))).toBe(true);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("diff");

    const completedWhileOpen = { ...completedDiff, turnId: RunId.make("turn-3") };
    const existingDiff = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      refA,
    );
    expect(store.openProactive(refA, completedWhileOpen, store.getUserActionRevision(refA))).toBe(
      false,
    );
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual(
      existingDiff,
    );
    store.closeSurface(refA, "diff");
    await reloadRightPanelStore();
    expect(store.openProactive(refA, completedWhileOpen, store.getUserActionRevision(refA))).toBe(
      false,
    );
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();

    // A later storage migration must preserve the dismissal, just like an ordinary reload.
    const { storage, name, version } = useRightPanelStore.persist.getOptions();
    const persisted = await storage!.getItem(name!);
    await storage!.setItem(name!, { ...persisted!, version: version! - 1 });
    await reloadRightPanelStore();
    expect(store.openProactive(refA, completedWhileOpen, store.getUserActionRevision(refA))).toBe(
      false,
    );
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();

    expect(
      store.openProactive(
        refA,
        { ...completedDiff, turnId: RunId.make("turn-4") },
        store.getUserActionRevision(refA),
      ),
    ).toBe(true);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("diff");
    store.closeSurface(refA, "diff");
    store.open(refA, "diff");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("diff");
  });

  it("keeps manual choices scoped to their thread and environment", () => {
    const otherEnvironment = scopeThreadRef("env-2" as EnvironmentId, refA.threadId);
    const store = useRightPanelStore.getState();
    const revision = store.getUserActionRevision(refA);
    store.openFile(refB, "src/app.ts");
    store.openFile(otherEnvironment, "src/app.ts");

    expect(store.openProactive(refA, completedDiff, revision)).toBe(true);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refB)).toBe("file");
    expect(
      selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, otherEnvironment),
    ).toBe("file");
  });

  it("does not treat resource reconciliation as a manual choice", () => {
    const store = useRightPanelStore.getState();
    store.openFile(refA, "src/app.ts");
    const revision = store.getUserActionRevision(refA);
    store.reconcileBrowserSurfaces(refA, ["agent-browser"]);
    store.reconcileFileSurfaces(refA, false);

    expect(store.openProactive(refA, completedDiff, revision)).toBe(true);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("diff");
  });

  it("keeps a maximized panel per thread without counting it as a manual choice", () => {
    const store = useRightPanelStore.getState();
    store.open(refA, "preview");
    store.open(refB, "diff");
    const revision = store.getUserActionRevision(refA);
    store.setMaximized(refA, true);
    store.setMaximized(refB, true);
    store.setMaximized(refB, false);

    const { byThreadKey } = useRightPanelStore.getState();
    expect(selectThreadRightPanelState(byThreadKey, refA).maximized).toBe(true);
    expect(selectThreadRightPanelState(byThreadKey, refB).maximized).toBeUndefined();
    expect(store.getUserActionRevision(refA)).toBe(revision);
  });

  it("restores a saved maximized panel during migration", () => {
    const migrated = migratePersistedRightPanelState({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "browser:new",
          surfaces: [{ id: "browser:new", kind: "preview", resourceId: null }],
          maximized: true,
        },
      },
    });
    expect(selectThreadRightPanelState(migrated.byThreadKey, refA).maximized).toBe(true);
  });

  it("drops the legacy singleton terminal surface during migration", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            activeSurfaceId: "terminal",
            surfaces: [
              { id: "browser:tab-a", kind: "preview", resourceId: "tab-a" },
              { id: "terminal", kind: "terminal" },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: false,
          activeSurfaceId: null,
          surfaces: [{ id: "browser:tab-a", kind: "preview", resourceId: "tab-a" }],
        },
      },
      threadPanelVisibilityByThreadKey: {},
    });
  });

  it("upgrades saved single-session terminal surfaces to split-capable surfaces", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "terminal:term-1",
            surfaces: [{ id: "terminal:term-1", kind: "terminal", resourceId: "term-1" }],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "terminal:term-1",
          surfaces: [
            {
              id: "terminal:term-1",
              kind: "terminal",
              resourceId: "term-1",
              terminalIds: ["term-1"],
              activeTerminalId: "term-1",
            },
          ],
        },
      },
      threadPanelVisibilityByThreadKey: {},
    });
  });

  it("upgrades the legacy singleton pull request surface to a reference-keyed tab", () => {
    const id = pullRequestSurfaceId({
      projectId: "project-a",
      repository: "pingdotgg/t3code",
      number: 4909,
    });
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "pull-request",
            surfaces: [
              {
                id: "pull-request",
                kind: "pull-request",
                projectId: "project-a",
                repository: "pingdotgg/t3code",
                number: 4909,
              },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: id,
          surfaces: [
            {
              id,
              kind: "pull-request",
              projectId: "project-a",
              repository: "pingdotgg/t3code",
              number: 4909,
            },
          ],
        },
      },
      threadPanelVisibilityByThreadKey: {},
    });
  });

  it("drops the pull-request list's shared panel so a restart opens the page fresh", () => {
    const id = pullRequestSurfaceId({
      projectId: "project-a",
      repository: "pingdotgg/t3code",
      number: 4909,
    });
    const panelState = {
      isOpen: true,
      activeSurfaceId: id,
      surfaces: [
        {
          id,
          kind: "pull-request" as const,
          projectId: "project-a",
          repository: "pingdotgg/t3code",
          number: 4909,
        },
      ],
    };
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:pull-requests-panel": panelState,
          "env-1:thread-A": panelState,
        },
      }),
    ).toEqual({
      byThreadKey: { "env-1:thread-A": panelState },
      threadPanelVisibilityByThreadKey: {},
    });
  });

  it.each([
    { kind: "plan", isOpen: true },
    { kind: "agents", isOpen: true },
    { kind: "agents", isOpen: false },
  ])("drops $kind with isOpen=$isOpen and falls back", ({ kind, isOpen }) => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen,
            activeSurfaceId: kind,
            surfaces: [{ id: kind, kind }],
          },
          "env-1:thread-B": {
            isOpen,
            activeSurfaceId: kind,
            surfaces: [
              { id: kind, kind },
              { id: "diff", kind: "diff" },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: false,
          activeSurfaceId: null,
          surfaces: [],
        },
        "env-1:thread-B": {
          isOpen,
          activeSurfaceId: "diff",
          surfaces: [{ id: "diff", kind: "diff" }],
        },
      },
      threadPanelVisibilityByThreadKey: {},
    });
  });

  it("persists inline preference without restoring an open popover", () => {
    expect(
      migratePersistedRightPanelState({
        threadPanelVisibilityByThreadKey: {
          "env-1:thread-A": { inlineOpen: false, popoverOpen: true },
          "env-1:thread-B": { inlineOpen: true, popoverOpen: true },
        },
      }),
    ).toEqual({
      byThreadKey: {},
      threadPanelVisibilityByThreadKey: {
        "env-1:thread-A": { inlineOpen: false, popoverOpen: false },
      },
    });
  });

  it("closes the popover atomically when the real right panel opens", () => {
    useRightPanelStore.getState().setThreadPanelOpen(refA, "popover", true);
    useRightPanelStore.getState().open(refA, "diff");

    expect(
      selectThreadPanelVisibility(
        useRightPanelStore.getState().threadPanelVisibilityByThreadKey,
        refA,
      ),
    ).toEqual({ inlineOpen: true, popoverOpen: false });
  });

  it("keeps an open popover visible by promoting it to inline when the real panel closes", () => {
    const store = useRightPanelStore.getState();
    store.open(refA, "diff");
    store.setThreadPanelOpen(refA, "inline", false);
    store.setThreadPanelOpen(refA, "popover", true);
    store.close(refA);

    expect(
      selectThreadPanelVisibility(
        useRightPanelStore.getState().threadPanelVisibilityByThreadKey,
        refA,
      ),
    ).toEqual({ inlineOpen: true, popoverOpen: true });
  });

  it("opens workspace-root links as the singleton files explorer", () => {
    const store = useRightPanelStore.getState();
    store.openFile(refA, "README.md");
    store.openFile(refA, ".");
    store.openFile(refA, ".");
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.activeSurfaceId).toBe("files");
    expect(state.surfaces.map((surface) => surface.id)).toEqual(["file:README.md", "files"]);
    store.closeSurface(refA, "files");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).activeSurfaceId,
    ).toBe("file:README.md");
    store.openFile(refA, ".");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).activeSurfaceId,
    ).toBe("files");
  });

  it("walks a folder browser up and back down in one tab", () => {
    const store = useRightPanelStore.getState();
    const state = () =>
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    store.openFile(refA, "README.md");
    store.openFile(refA, "apps/web/src");

    store.navigateFolder(refA, "file:apps/web/src", "apps", "apps/web/src");
    expect(state().activeSurfaceId).toBe("file:apps");
    expect(state().surfaces).toEqual([
      expect.objectContaining({ id: "file:README.md" }),
      expect.objectContaining({
        id: "file:apps",
        relativePath: "apps",
        folderTrail: "apps/web/src",
      }),
    ]);

    // The workspace root is the files explorer, still holding the way back down.
    store.navigateFolder(refA, "file:apps", "", "apps/web/src");
    expect(state().surfaces.map((surface) => surface.id)).toEqual(["file:README.md", "files"]);
    expect(state().surfaces[1]).toEqual({
      id: "files",
      kind: "files",
      folderTrail: "apps/web/src",
    });

    // Reaching the end of the trail leaves no trail behind.
    store.navigateFolder(refA, "files", "apps/web/src", "apps/web/src");
    expect(state().activeSurfaceId).toBe("file:apps/web/src");
    expect(state().surfaces[1]).toEqual({
      id: "file:apps/web/src",
      kind: "file",
      relativePath: "apps/web/src",
      revealLine: null,
      revealRequestId: 1,
    });
  });

  it("switches to a tab that already shows the folder instead of replacing it", () => {
    const store = useRightPanelStore.getState();
    store.openFile(refA, "apps");
    store.openFile(refA, "apps/web/src", 12);

    store.navigateFolder(refA, "file:apps/web/src", "apps", "apps/web/src");
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.activeSurfaceId).toBe("file:apps");
    expect(state.surfaces).toEqual([
      { id: "file:apps", kind: "file", relativePath: "apps", revealLine: null, revealRequestId: 1 },
    ]);
  });

  it("keeps a file's tab when walking up from it, and comes back to it", () => {
    const store = useRightPanelStore.getState();
    const state = () =>
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    store.openFile(refA, "src/app.ts", 40);

    store.navigateFolder(refA, "file:src/app.ts", "src", "src/app.ts", true);
    expect(state().activeSurfaceId).toBe("file:src");
    expect(state().surfaces).toEqual([
      {
        id: "file:src/app.ts",
        kind: "file",
        relativePath: "src/app.ts",
        revealLine: 40,
        revealRequestId: 1,
      },
      expect.objectContaining({ id: "file:src", folderTrail: "src/app.ts" }),
    ]);

    // The trail's end is the file: its tab comes back as it was, the folder tab goes.
    store.navigateFolder(refA, "file:src", "src/app.ts", "src/app.ts");
    expect(state().activeSurfaceId).toBe("file:src/app.ts");
    expect(state().surfaces).toEqual([
      {
        id: "file:src/app.ts",
        kind: "file",
        relativePath: "src/app.ts",
        revealLine: 40,
        revealRequestId: 1,
      },
    ]);
  });

  // regression: #15045 breadcrumb navigation from a closed tab must not resurrect it
  it("ignores navigation from a tab that was closed", () => {
    const store = useRightPanelStore.getState();
    store.openFile(refA, "apps");
    const before = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    store.navigateFolder(refA, "file:gone", "", "gone");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toBe(
      before,
    );
  });

  it("replaces the standalone explorer with peer file surfaces", () => {
    useRightPanelStore.getState().open(refA, "files");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openFile(refA, "README.md");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:README.md",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: null,
          revealRequestId: 2,
        },
        {
          id: "file:README.md",
          kind: "file",
          relativePath: "README.md",
          revealLine: null,
          revealRequestId: 1,
        },
      ],
    });
  });

  it.each([
    ["generated\\", "generated"],
    ["notes/meeting ", "notes/meeting"],
    [" notes/meeting", "notes/meeting"],
  ])("keeps %j and %j in separate file tabs", (firstPath, secondPath) => {
    useRightPanelStore.getState().openFile(refA, firstPath);
    useRightPanelStore.getState().openFile(refA, secondPath);

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toMatchObject([
      { id: `file:${firstPath}`, relativePath: firstPath },
      { id: `file:${secondPath}`, relativePath: secondPath },
    ]);
  });

  it("keeps attachment and workspace file ids disjoint", () => {
    useRightPanelStore.getState().openFile(refA, "attachment:shared-id");
    useRightPanelStore.getState().openAttachment(refA, {
      type: "file",
      id: "shared-id",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
    });

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["file:attachment:shared-id", "attachment:shared-id"]);
  });

  it("updates line reveal requests when reopening a file surface", () => {
    useRightPanelStore.getState().openFile(refA, "src/index.ts", 42);
    useRightPanelStore.getState().openFile(refA, "src/index.ts", 87);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:src/index.ts",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: 87,
          revealRequestId: 2,
        },
      ],
    });

    useRightPanelStore.getState().openFile(refA, "src/index.ts");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:src/index.ts",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: null,
          revealRequestId: 3,
        },
      ],
    });
  });

  it("removes persisted file surfaces when their workspace no longer exists", () => {
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().open(refA, "device");
    useRightPanelStore.getState().openFile(refA, "README.md");

    useRightPanelStore.getState().reconcileFileSurfaces(refA, false);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "device",
      surfaces: [{ id: "device", kind: "device" }],
    });

    useRightPanelStore.getState().openFile(refB, "conductor.json");
    useRightPanelStore.getState().reconcileFileSurfaces(refB, false);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refB)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("keeps attachment previews when their workspace is unavailable", () => {
    const attachment = {
      type: "file" as const,
      id: "thread-A-attachment-pdf",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
    };
    useRightPanelStore.getState().openFile(refA, "README.md");
    useRightPanelStore.getState().openAttachment(refA, attachment);

    useRightPanelStore.getState().reconcileFileSurfaces(refA, false);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "attachment:thread-A-attachment-pdf",
      surfaces: [
        {
          id: "attachment:thread-A-attachment-pdf",
          kind: "file",
          relativePath: "report.pdf",
          revealLine: null,
          revealRequestId: 0,
          attachment,
        },
      ],
    });
  });

  it("tracks one surface per pull request", () => {
    const first = { projectId: "project-a", repository: "pingdotgg/t3code", number: 4909 };
    const second = { projectId: "project-a", repository: "pingdotgg/t3code", number: 4910 };
    useRightPanelStore.getState().openPullRequest(refA, first);
    useRightPanelStore.getState().openPullRequest(refA, second);
    const url = "https://gitlab.example.com/pingdotgg/t3code/-/merge_requests/4909";
    useRightPanelStore.getState().openPullRequest(refA, { ...first, url });
    useRightPanelStore.getState().openPullRequest(refA, first);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      pullRequestSurfaceId(first),
      pullRequestSurfaceId(second),
    ]);
    expect(state.activeSurfaceId).toBe(pullRequestSurfaceId(first));
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA),
    ).toMatchObject({ url });
    expect(state.surfaces[1]).not.toHaveProperty("url");
  });

  it("restores each environment, thread and PR surface's detail tab after reload and URL reopen", async () => {
    const pr = { projectId: "project-a", repository: "pingdotgg/t3code", number: 4909 };
    const otherPr = { ...pr, projectId: "project-b" };
    const otherEnvironment = scopeThreadRef("env-2" as EnvironmentId, refA.threadId);
    const selections = [
      [refA, pr, "code"],
      [refB, pr, "guide"],
      [otherEnvironment, pr, "timeline"],
      [refA, otherPr, "summary"],
    ] as const;
    const store = useRightPanelStore.getState();
    for (const [ref, reference, tab] of selections) {
      store.openPullRequest(ref, reference);
      store.setPullRequestDetailTab(ref, pullRequestSurfaceId(reference), "guide");
      store.setPullRequestDetailTab(ref, pullRequestSurfaceId(reference), tab);
    }

    store.openPullRequest(refA, pr);
    const revision = store.getUserActionRevision(refA);
    store.setPullRequestDetailTab(refA, pullRequestSurfaceId(pr), "timeline");
    expect(store.openProactive(refA, linkedPullRequest, revision)).toBe(true);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual(
      linkedPullRequest,
    );
    store.setPullRequestDetailTab(refA, pullRequestSurfaceId(pr), "code");

    const { storage, name } = useRightPanelStore.persist.getOptions();
    const saved = await storage!.getItem(name!);
    expect(saved).not.toBeNull();
    useRightPanelStore.setState({ byThreadKey: {} });
    await storage!.setItem(name!, saved!);
    await useRightPanelStore.persist.rehydrate();

    for (const [ref, reference, tab] of selections) {
      store.openPullRequest(ref, {
        ...reference,
        url: `https://github.com/${reference.repository}/pull/${reference.number}`,
      });
      const active = selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref);
      expect(active?.id).toBe(pullRequestSurfaceId(reference));
      expect(active?.kind === "pull-request" && (active.detailTab ?? "summary")).toBe(tab);
      store.closeSurface(ref, active!.id);
      await reopenClosedView(useClosedViewStore.getState().entries[0]!, {
        workspaceAvailable: true,
        openPreview: () => {
          throw new Error("A PR tab must not create a browser session");
        },
      });
      const reopened = selectActiveRightPanelSurface(
        useRightPanelStore.getState().byThreadKey,
        ref,
      );
      expect(reopened?.kind === "pull-request" && (reopened.detailTab ?? "summary")).toBe(tab);
    }
  });

  it("keeps matching repository and number on different hosts as separate tabs", () => {
    const first = { projectId: "project-a", repository: "acme/api", number: 7, host: "github.com" };
    const second = { ...first, host: "github.example.com" };
    useRightPanelStore.getState().openPullRequest(refA, first);
    useRightPanelStore.getState().openPullRequest(refA, second);
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces).toEqual([pullRequestSurface(first), pullRequestSurface(second)]);
    expect(pullRequestSurfaceId({ ...first, host: "GITHUB.COM" })).toBe(
      pullRequestSurfaceId(first),
    );
  });

  it("keeps the page's panel tabs reachable when the set of connected servers changes", () => {
    const panelId = ThreadId.make("pull-requests-panel");
    const stableRef = scopeThreadRef("pull-requests-panel" as EnvironmentId, panelId);
    const fromServerA = {
      environmentId: "server-a",
      projectId: "project-a",
      repository: "pingdotgg/t3code",
      number: 1,
    };
    const fromServerB = {
      environmentId: "server-b",
      projectId: "project-b",
      repository: "pingdotgg/t3code",
      number: 2,
    };

    useRightPanelStore.getState().openPullRequest(stableRef, fromServerA);
    useRightPanelStore.getState().openPullRequest(stableRef, fromServerB);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, stableRef);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      pullRequestSurfaceId(fromServerA),
      pullRequestSurfaceId(fromServerB),
    ]);

    const refWhileBothConnected = scopeThreadRef("server-a" as EnvironmentId, panelId);
    const refAfterServerADisconnects = scopeThreadRef("server-b" as EnvironmentId, panelId);
    expect(refWhileBothConnected).not.toEqual(refAfterServerADisconnects);
    expect(
      selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        refAfterServerADisconnects,
      ).surfaces,
    ).toEqual([]);
  });

  it("tracks split panes and the active pane within a terminal surface", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().splitTerminal(refA, "terminal:term-1", "term-2");

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "terminal:term-1",
      kind: "terminal",
      resourceId: "term-1",
      terminalIds: ["term-1", "term-2"],
      activeTerminalId: "term-2",
    });

    useRightPanelStore.getState().activateTerminal(refA, "terminal:term-1", "term-1");
    useRightPanelStore.getState().closeTerminal(refA, "terminal:term-1", "term-1");
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "terminal:term-1",
      kind: "terminal",
      resourceId: "term-1",
      terminalIds: ["term-2"],
      activeTerminalId: "term-2",
    });
  });

  it("closing the final terminal pane removes its surface and closes the panel", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().closeTerminal(refA, "terminal:term-1", "term-1");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("closing the active surface activates a neighboring surface", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().closeSurface(refA, "terminal:term-1");

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "browser:tab-a",
    );
  });

  it("closing surfaces to the right activates the selected surface when active was removed", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openTerminal(refA, "term-1");

    useRightPanelStore.getState().closeSurfacesToRight(refA, "browser:tab-a");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "browser:tab-a",
      surfaces: [{ id: "browser:tab-a", kind: "preview", resourceId: "tab-a" }],
    });
  });

  it("does not replace a stale surface with a hidden tab, but preserves explicit opens", () => {
    const store = useRightPanelStore.getState();
    store.openBrowser(refA, "stale-tab");
    store.reconcileBrowserSurfaces(refA, ["hidden-tab"], new Set(["hidden-tab"]));
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA),
    ).toMatchObject({
      activeSurfaceId: null,
      surfaces: [],
    });

    store.openBrowser(refA, "hidden-tab");
    store.reconcileBrowserSurfaces(
      refA,
      ["hidden-tab", "other-tab"],
      new Set(["hidden-tab", "other-tab"]),
    );
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA),
    ).toMatchObject({
      isOpen: true,
      activeSurfaceId: "browser:hidden-tab",
      surfaces: [{ id: "browser:hidden-tab", kind: "preview", resourceId: "hidden-tab" }],
    });
  });

  it("moves a surface to a new index and keeps it there through browser reconciliation", () => {
    const store = useRightPanelStore.getState();
    store.openTerminal(refA, "term-1");
    store.openBrowser(refA, "tab-a");
    store.open(refA, "diff");
    const revision = store.getUserActionRevision(refA);
    const surfaceIds = () =>
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      );

    store.moveSurface(refA, "browser:tab-a", 0);
    expect(surfaceIds()).toEqual(["browser:tab-a", "terminal:term-1", "diff"]);
    store.moveSurface(refA, "browser:tab-a", 2);
    expect(surfaceIds()).toEqual(["terminal:term-1", "diff", "browser:tab-a"]);
    store.moveSurface(refA, "browser:tab-a", 0);

    store.reconcileBrowserSurfaces(refA, ["tab-a", "tab-b"]);
    expect(surfaceIds()).toEqual(["browser:tab-a", "terminal:term-1", "diff", "browser:tab-b"]);
    expect(store.getUserActionRevision(refA)).toBe(revision);
  });
});
