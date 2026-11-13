import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { useClosedViewStore } from "./closedViewStore";
import { reopenClosedView } from "./reopenClosedView";
import {
  hostRightPanel,
  migratePersistedRightPanelState,
  pullRequestSurface,
  pullRequestSurfaceId,
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectThreadPanelVisibility,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";
beforeEach(() => {
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
});

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));

const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

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
  const completedDiff = { kind: "diff", turnId: RunId.make("turn-1") } as const;

  const linkedPullRequest = pullRequestSurface({
    projectId: "project-a",
    repository: "pingdotgg/t3code",
    number: 42,
  });

  it("opens a hosted side chat's panel actions in its parent's panel until unhosted", () => {
    const store = useRightPanelStore.getState();
    const unhost = hostRightPanel(refB, refA);
    store.openFile(refB, "src/app.ts");
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "file:src/app.ts",
    );
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refB).surfaces,
    ).toEqual([]);
    unhost();
    store.openFile(refB, "src/app.ts");
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refB)?.id).toBe(
      "file:src/app.ts",
    );
  });

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

    store.navigateFolder(refA, "file:apps", "", "apps/web/src");
    expect(state().surfaces.map((surface) => surface.id)).toEqual(["file:README.md", "files"]);
    expect(state().surfaces[1]).toEqual({
      id: "files",
      kind: "files",
      folderTrail: "apps/web/src",
    });

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
});
