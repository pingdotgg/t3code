import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ViewRecord } from "@t3tools/extension-sdk/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createJSONStorage } from "zustand/middleware";
import { createMemoryStorage } from "./lib/storage";
import {
  extensionPanelSurface,
  type ExtensionPanelSurface,
  type RightPanelSurface,
  migratePersistedRightPanelState,
  selectThreadExtensionDock,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

const a = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("a"));
const b = scopeThreadRef(a.environmentId, ThreadId.make("b"));
const record = (
  placement: ViewRecord["placement"] = "bottom-dock",
  id = "counter",
): ViewRecord => ({
  version: 1,
  surfaceId: "community.counter/view",
  stateVersion: 1,
  placement,
  restoreState: 0,
  fallback: "Counter unavailable",
  context: {
    client: "web",
    resource: {
      namespace: "community.counter",
      id,
      environmentId: a.environmentId,
      projectId: "shared-project",
    },
  },
});
const dock = (ref = a) =>
  selectThreadExtensionDock(useRightPanelStore.getState().extensionDockByThreadKey, ref);
const side = (ref = a) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
let memory = createMemoryStorage();
beforeEach(() => {
  memory = createMemoryStorage();
  useRightPanelStore.persist.setOptions({ storage: createJSONStorage(() => memory) });
  useRightPanelStore.setState({
    byThreadKey: {},
    extensionDockByThreadKey: {},
    userActionRevisionByThreadKey: {},
  });
});

describe("generic extension placements", () => {
  it("opens distinct viewers at side and dock, saves only the addressed placement, and keeps thread owners separate", () => {
    const store = useRightPanelStore.getState();
    expect(store.openExtension(a, record("side-panel"))).toBe(true);
    expect(store.openExtension(a, record())).toBe(true);
    expect(store.openExtension(b, record())).toBe(true);
    expect(side().surfaces).toHaveLength(1);
    expect(dock().surfaces).toHaveLength(1);
    store.hideExtensionDock(a);
    const revision = store.getUserActionRevision(a);
    expect(
      store.updateExtensionRecord(
        a,
        { ...record(), restoreState: 3 },
        dock().surfaces[0]?.viewerGeneration,
      ),
    ).toBe(true);
    expect(dock().surfaces[0]?.record.restoreState).toBe(3);
    expect(dock().isOpen).toBe(false);
    expect(side().surfaces[0]).toMatchObject({ record: { restoreState: 0 } });
    expect(dock(b).surfaces[0]?.record.restoreState).toBe(0);
    expect(store.getUserActionRevision(a)).toBe(revision);
    store.showExtensionDock(a);
    expect(dock().surfaces[0]?.record.restoreState).toBe(3);
    store.closeDockExtension(a, dock().surfaces[0]!.id);
    expect(dock().surfaces).toEqual([]);
    expect(store.updateExtensionRecord(a, { ...record(), restoreState: 4 })).toBe(false);
    expect(side().surfaces).toHaveLength(1);
    expect(dock(b).surfaces).toHaveLength(1);
    store.removeThread(b);
    expect(dock(b).surfaces).toEqual([]);
  });

  it("does not mutate layout or activate an unsupported or foreign record", () => {
    const store = useRightPanelStore.getState();
    store.open(a, "diff");
    const before = useRightPanelStore.getState();
    for (const placement of ["full-page", "compact-detail"] as const) {
      expect(store.openExtension(a, record(placement))).toBe(false);
      expect(store.updateExtensionRecord(a, record(placement))).toBe(false);
      expect(useRightPanelStore.getState()).toBe(before);
    }
    expect(
      store.openExtension(a, {
        ...record(),
        context: {
          ...record().context,
          resource: { ...record().context.resource, threadId: "other" },
        },
      }),
    ).toBe(false);
    expect(useRightPanelStore.getState()).toBe(before);
  });

  it("shares the64-view limit across placements and rejects stale automatic opens", () => {
    const store = useRightPanelStore.getState();
    for (let i = 0; i < 32; i++) {
      expect(store.openExtension(a, record("side-panel", String(i)))).toBe(true);
      expect(store.openExtension(a, record("bottom-dock", String(i)))).toBe(true);
    }
    expect(store.openExtension(a, record("bottom-dock", "overflow"))).toBe(false);
    expect(store.openExtension(a, record("side-panel", "overflow"))).toBe(false);
    const revision = store.getUserActionRevision(a);
    store.hideExtensionDock(a);
    expect(store.openExtension(a, record(), revision)).toBe(false);
    expect(dock().isOpen).toBe(false);
    expect(store.openExtension(a, { ...record("bottom-dock", "0"), restoreState: 5 })).toBe(true);
    expect(dock().surfaces).toHaveLength(32);
  });

  it("selects surviving tabs on close and never changes native panel focus", () => {
    const store = useRightPanelStore.getState();
    store.open(a, "files");
    store.openExtension(a, record("bottom-dock", "one"));
    store.openExtension(a, record("bottom-dock", "two"));
    const first = dock().surfaces[0]!.id;
    const second = dock().surfaces[1]!.id;
    store.activateDockExtension(a, first);
    expect(dock().activeSurfaceId).toBe(first);
    store.closeDockExtension(a, first);
    expect(dock().activeSurfaceId).toBe(second);
    expect(dock().isOpen).toBe(true);
    expect(side().activeSurfaceId).toBe("files");
    store.closeDockExtension(a, second);
    expect(dock().isOpen).toBe(false);
    store.showExtensionDock(a);
    expect(dock().isOpen).toBe(false);
  });

  it("moves legacy bottom records while preserving native tabs and unsupported recovery records", () => {
    const bottom = extensionPanelSurface(a, { ...record(), restoreState: 7 })!;
    const unsupported = extensionPanelSurface(a, record("full-page", "page"))!;
    const normalized = migratePersistedRightPanelState({
      byThreadKey: {
        [scopedThreadKey(a)]: {
          isOpen: true,
          activeSurfaceId: bottom.id,
          surfaces: [{ kind: "files", id: "files" }, bottom, unsupported],
        },
      },
    });
    expect(normalized.byThreadKey[scopedThreadKey(a)]).toEqual({
      isOpen: true,
      activeSurfaceId: "files",
      surfaces: [{ kind: "files", id: "files" }, unsupported],
    });
    expect(normalized.extensionDockByThreadKey[scopedThreadKey(a)]).toEqual({
      isOpen: true,
      activeSurfaceId: bottom.id,
      surfaces: [bottom],
    });
    expect(migratePersistedRightPanelState(normalized)).toEqual(normalized);
    const inactive = migratePersistedRightPanelState({
      byThreadKey: {
        [scopedThreadKey(a)]: {
          isOpen: true,
          activeSurfaceId: "files",
          surfaces: [{ kind: "files", id: "files" }, bottom],
        },
      },
    });
    expect(inactive.extensionDockByThreadKey[scopedThreadKey(a)]?.isOpen).toBe(false);
  });

  it("normalizes both maps on current hydration, keeps current dock state over legacy duplicates and survives reload", async () => {
    const bottom = extensionPanelSurface(a, record())!;
    const options = useRightPanelStore.persist.getOptions();
    if (!options.name) throw new Error("Missing storage name");
    memory.setItem(
      options.name,
      JSON.stringify({
        version: options.version,
        state: {
          byThreadKey: {
            [scopedThreadKey(a)]: { isOpen: true, activeSurfaceId: bottom.id, surfaces: [bottom] },
          },
          extensionDockByThreadKey: {
            [scopedThreadKey(a)]: {
              isOpen: false,
              activeSurfaceId: bottom.id,
              surfaces: [
                { ...bottom, record: { ...bottom.record, restoreState: 9 } },
                { ...bottom, id: "malformed", record: null },
              ],
            },
          },
        },
      }),
    );
    await useRightPanelStore.persist.rehydrate();
    expect(side().surfaces).toEqual([]);
    expect(dock().isOpen).toBe(false);
    expect(dock().surfaces).toHaveLength(1);
    expect(dock().surfaces[0]?.record.restoreState).toBe(9);
    useRightPanelStore.getState().showExtensionDock(a);
    const persisted = await memory.getItem(options.name);
    expect(persisted).not.toBeNull();
    const state = migratePersistedRightPanelState(JSON.parse(persisted!).state);
    expect(
      state.extensionDockByThreadKey[scopedThreadKey(a)]?.surfaces[0]?.record.restoreState,
    ).toBe(9);
  });
  it("bounds combined persisted placements and removes session-only dock layouts", () => {
    const sideSurfaces = Array.from({ length: 40 }, (_, i) =>
      extensionPanelSurface(a, record("side-panel", String(i)))!,
    );
    const dockSurfaces = Array.from({ length: 40 }, (_, i) =>
      extensionPanelSurface(a, record("bottom-dock", String(i)))!,
    );
    const normalized = migratePersistedRightPanelState({
      byThreadKey: { [scopedThreadKey(a)]: { isOpen: true, surfaces: sideSurfaces } },
      extensionDockByThreadKey: {
        [scopedThreadKey(a)]: { isOpen: true, surfaces: dockSurfaces },
        "env:pull-requests-panel": { isOpen: true, surfaces: dockSurfaces },
      },
    });
    expect(normalized.byThreadKey[scopedThreadKey(a)]?.surfaces).toHaveLength(40);
    expect(normalized.extensionDockByThreadKey[scopedThreadKey(a)]?.surfaces).toHaveLength(24);
    expect(normalized.extensionDockByThreadKey["env:pull-requests-panel"]).toBeUndefined();
    expect(migratePersistedRightPanelState(normalized)).toEqual(normalized);
  });
  it("stores a user-chosen dock height per thread and carries it through hydration", () => {
    const store = useRightPanelStore.getState();
    store.openExtension(a, record());
    store.openExtension(b, record());
    store.setExtensionDockHeight(a, 480);
    store.setExtensionDockHeight(a, Number.NaN);
    store.setExtensionDockHeight(a, Number.POSITIVE_INFINITY);
    expect(dock().height).toBe(480);
    expect(dock(b).height).toBeUndefined();
    const surface = dock().surfaces[0]!;
    const normalized = migratePersistedRightPanelState({
      extensionDockByThreadKey: {
        [scopedThreadKey(a)]: {
          isOpen: true,
          activeSurfaceId: surface.id,
          surfaces: [surface],
          height: 480,
        },
        [scopedThreadKey(b)]: {
          isOpen: true,
          activeSurfaceId: surface.id,
          surfaces: [surface],
          height: "tall",
        },
      },
    });
    expect(normalized.extensionDockByThreadKey[scopedThreadKey(a)]?.height).toBe(480);
    expect(normalized.extensionDockByThreadKey[scopedThreadKey(b)]?.height).toBeUndefined();
    expect(migratePersistedRightPanelState(normalized)).toEqual(normalized);
    store.closeDockExtension(a, surface.id);
    expect(dock().height).toBeUndefined();
  });

  it("rejects misplaced dock entries before deduplicating or consuming the view limit", () => {
    const valid = extensionPanelSurface(a, { ...record(), restoreState: 8 })!;
    const invalidPlacements = Array.from({ length: 64 }, (_, i) =>
      extensionPanelSurface(a, record("side-panel", i === 0 ? "counter" : String(i)))!,
    );
    const normalized = migratePersistedRightPanelState({
      extensionDockByThreadKey: {
        [scopedThreadKey(a)]: {
          isOpen: true,
          activeSurfaceId: valid.id,
          surfaces: [...invalidPlacements, valid],
        },
      },
    });
    expect(normalized.extensionDockByThreadKey[scopedThreadKey(a)]?.surfaces).toEqual([valid]);
    expect(normalized.byThreadKey).toEqual({});
  });
});

for (const placement of ["side-panel", "bottom-dock"] as const) {
  it(`rejects stale metadata and closed/reopened owners in ${placement}`, () => {
    const store = useRightPanelStore.getState();
    const current = () => {
      const surfaces: readonly RightPanelSurface[] = (placement === "bottom-dock" ? dock() : side())
        .surfaces;
      return surfaces.find((entry): entry is ExtensionPanelSurface => entry.kind === "extension");
    };
    const old = record(placement);
    store.openExtension(a, old);
    const oldGeneration = current()!.viewerGeneration;
    const next = {
      ...old,
      stateVersion: 2,
      context: { ...old.context, workspaceRevision: "new-revision" },
    };
    store.openExtension(a, next);
    const nextGeneration = current()!.viewerGeneration;
    expect(store.updateExtensionRecord(a, { ...old, restoreState: 99 }, oldGeneration)).toBe(false);
    expect(store.updateExtensionRecord(a, { ...old, restoreState: 99 }, nextGeneration)).toBe(
      false,
    );
    expect(current()!.record).toEqual(next);
    expect(store.updateExtensionRecord(a, { ...next, restoreState: 5 }, nextGeneration)).toBe(true);
    expect(current()!.viewerGeneration).toBe(nextGeneration);
    const id = current()!.id;
    if (placement === "bottom-dock") store.closeDockExtension(a, id);
    else store.closeSurface(a, id);
    store.openExtension(a, next);
    expect(store.updateExtensionRecord(a, { ...next, restoreState: 99 }, nextGeneration)).toBe(
      false,
    );
    expect(current()!.record.restoreState).toBe(0);
  });
  it(`rejects an absent hydrated generation after a fresh open in ${placement}`, () => {
    const value = record(placement),
      surface = extensionPanelSurface(a, value)!;
    const key = scopedThreadKey(a);
    if (placement === "bottom-dock")
      useRightPanelStore.setState({
        extensionDockByThreadKey: {
          [key]: { isOpen: false, activeSurfaceId: surface.id, surfaces: [surface] },
        },
      });
    else
      useRightPanelStore.setState({
        byThreadKey: { [key]: { isOpen: false, activeSurfaceId: surface.id, surfaces: [surface] } },
      });
    const store = useRightPanelStore.getState();
    expect(store.updateExtensionRecord(a, { ...value, restoreState: 1 }, undefined)).toBe(true);
    store.openExtension(a, value);
    expect(store.updateExtensionRecord(a, { ...value, restoreState: 99 }, undefined)).toBe(false);
  });
}
