import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { type ViewRecord } from "@t3tools/extension-sdk/contracts";
import { createExtensionHost } from "@t3tools/extension-sdk/host";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createJSONStorage } from "zustand/middleware";

import { createMemoryStorage } from "./lib/storage";
import {
  extensionPanelSurface,
  migratePersistedRightPanelState,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

const ref = scopeThreadRef(EnvironmentId.make("east"), ThreadId.make("thread"));
const state = (target = ref) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, target);
const record = (id = "resource", target: ScopedThreadRef = ref): ViewRecord => ({
  version: 1,
  surfaceId: "external.inventory/stock",
  context: {
    client: "web",
    resource: {
      namespace: "external.inventory",
      id,
      environmentId: target.environmentId,
      projectId: "project",
      threadId: target.threadId,
    },
  },
  placement: "side-panel",
  stateVersion: 1,
  restoreState: { selection: "apples" },
  fallback: "Inventory is unavailable",
});
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

describe("generic extension layout records", () => {
  it("opens a copied record, updates it in place and preserves native order, focus and reopen", () => {
    const store = useRightPanelStore.getState();
    store.open(ref, "diff");
    const value = record();
    expect(store.openExtension(ref, value)).toBe(true);
    const selected = state().surfaces[1]!;
    expect(selected.kind).toBe("extension");
    expect(selected).toMatchObject(extensionPanelSurface(ref, value)!);
    (value.restoreState as { selection: string }).selection = "mutated by caller";
    expect(selected.kind === "extension" && selected.record.restoreState).toEqual({
      selection: "apples",
    });
    store.open(ref, "agents");
    store.openExtension(ref, {
      ...record(),
      restoreState: { selection: "pears" },
      context: { ...record().context, workspaceRevision: "new" },
    });
    expect(state().surfaces.map((s) => s.kind)).toEqual(["diff", "extension", "agents"]);
    expect(state().activeSurfaceId).toBe(selected.id);
    expect(state().surfaces[1]).toMatchObject({
      record: { restoreState: { selection: "pears" }, context: { workspaceRevision: "new" } },
    });
    store.moveSurface(ref, selected.id, 0);
    expect(state().surfaces.map((s) => s.kind)).toEqual(["extension", "diff", "agents"]);
    expect(state().activeSurfaceId).toBe(selected.id);
    store.close(ref);
    expect(state().isOpen).toBe(false);
    store.moveSurface(ref, selected.id, 999);
    expect(state().isOpen).toBe(false);
    expect(state().activeSurfaceId).toBe(selected.id);
    store.show(ref);
    store.closeSurface(ref, selected.id);
    expect(state().activeSurfaceId).toBe("agents");
    expect(store.openExtension(ref, record())).toBe(true);
    expect(state().surfaces.at(-1)?.id).toBe(selected.id);
  });

  it("supports project and environment resource records in a thread layout", () => {
    const { threadId: _thread, ...projectResource } = record().context.resource;
    const project = { ...record(), context: { ...record().context, resource: projectResource } };
    const { projectId: _project, ...environmentResource } = projectResource;
    const environment = {
      ...record(),
      context: { ...record().context, resource: environmentResource },
    };
    const store = useRightPanelStore.getState();
    expect(store.openExtension(ref, project)).toBe(true);
    expect(store.openExtension(ref, environment)).toBe(true);
    expect(state().surfaces).toHaveLength(2);
    expect(state().surfaces.map((s) => s.id)).toEqual([
      extensionPanelSurface(ref, project)?.id,
      extensionPanelSurface(ref, environment)?.id,
    ]);
    const restored = migratePersistedRightPanelState({
      byThreadKey: { [scopedThreadKey(ref)]: state() },
    });
    expect(restored.byThreadKey[scopedThreadKey(ref)]).toEqual({
      ...state(),
      surfaces: state().surfaces.map((surface) =>
        surface.kind === "extension" ? extensionPanelSurface(ref, surface.record) : surface,
      ),
    });
  });

  it("isolates identities across scopes and rejects mismatched or ambiguous thread keys", () => {
    const store = useRightPanelStore.getState();
    const west = scopeThreadRef(EnvironmentId.make("west"), ref.threadId);
    const otherThread = scopeThreadRef(ref.environmentId, ThreadId.make("other"));
    expect(store.openExtension(ref, record())).toBe(true);
    expect(store.openExtension(west, record("resource", west))).toBe(true);
    expect(state().surfaces[0]?.id).not.toBe(state(west).surfaces[0]?.id);
    const before = state();
    expect(store.openExtension(ref, record("resource", west))).toBe(false);
    expect(store.openExtension(ref, record("resource", otherThread))).toBe(false);
    expect(state()).toBe(before);
    const ambiguous = scopeThreadRef(EnvironmentId.make("east:sub"), ref.threadId);
    expect(store.openExtension(ambiguous, record("resource", ambiguous))).toBe(false);
    expect(
      extensionPanelSurface(ref, { ...record(), surfaceId: "another.inventory/stock" })?.id,
    ).not.toBe(before.surfaces[0]?.id);
    expect(
      extensionPanelSurface(ref, {
        ...record(),
        context: {
          ...record().context,
          resource: { ...record().context.resource, projectId: "another" },
        },
      })?.id,
    ).not.toBe(before.surfaces[0]?.id);
  });

  it("guards automatic extension requests against later user choices and does not increment automatic revisions", () => {
    const store = useRightPanelStore.getState();
    const start = store.getUserActionRevision(ref);
    expect(store.openExtension(ref, record(), start)).toBe(true);
    expect(store.getUserActionRevision(ref)).toBe(start);
    store.moveSurface(ref, state().activeSurfaceId!, 0);
    expect(store.openExtension(ref, record("late"), start)).toBe(false);
    const next = store.getUserActionRevision(ref);
    store.openExtension(ref, record("manual"));
    expect(store.openProactive(ref, { kind: "diff", id: "diff" }, next)).toBe(false);
    const chosen = state();
    store.close(ref);
    expect(store.openExtension(ref, record("late"), store.getUserActionRevision(ref) - 1)).toBe(
      false,
    );
    expect(state().activeSurfaceId).toBe(chosen.activeSurfaceId);
    expect(state().isOpen).toBe(false);
  });

  it.each([
    ["unknown version", { ...record(), version: 2 }],
    ["invalid state version", { ...record(), stateVersion: 0 }],
    ["unknown placement", { ...record(), placement: "floating" }],
    ["unnamespaced contribution", { ...record(), surfaceId: "stock" }],
    ["empty fallback", { ...record(), fallback: "  " }],
    ["missing context", { ...record(), context: null }],
    ["missing restore state", { ...record(), restoreState: undefined }],
    ["function state", { ...record(), restoreState: () => null }],
    ["oversized state", { ...record(), restoreState: "x".repeat(65536) }],
    ["multibyte oversized state", { ...record(), restoreState: "界".repeat(23000) }],
    [
      "invalid thread scope",
      {
        ...record(),
        context: {
          ...record().context,
          resource: {
            namespace: "external.inventory",
            id: "resource",
            environmentId: "east",
            threadId: "thread",
          },
        },
      },
    ],
  ])("rejects %s without changing layout or user revision", (_name, value) => {
    const store = useRightPanelStore.getState();
    store.open(ref, "agents");
    const before = state();
    const revision = store.getUserActionRevision(ref);
    expect(store.openExtension(ref, value as unknown as ViewRecord)).toBe(false);
    expect(state()).toBe(before);
    expect(store.getUserActionRevision(ref)).toBe(revision);
  });

  it("rejects cyclic and deeply nested data and caps distinct extension records", () => {
    const store = useRightPanelStore.getState();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    let deep: unknown = null;
    for (let i = 0; i < 40; i++) deep = { child: deep };
    for (const restoreState of [cyclic, deep])
      expect(store.openExtension(ref, { ...record(), restoreState } as ViewRecord)).toBe(false);
    for (let i = 0; i < 64; i++) expect(store.openExtension(ref, record(String(i)))).toBe(true);
    const revision = store.getUserActionRevision(ref);
    expect(store.openExtension(ref, record("overflow"))).toBe(false);
    expect(store.getUserActionRevision(ref)).toBe(revision);
    expect(store.openExtension(ref, { ...record("0"), restoreState: null })).toBe(true);
    expect(state().surfaces).toHaveLength(64);
  });

  it("normalizes persisted records and active identity while dropping malformed, duplicate and foreign scopes", () => {
    const valid = extensionPanelSurface(ref, record())!;
    const malformed = [
      null,
      { kind: "extension", record: null },
      { kind: "extension", record: { ...record(), restoreState: "x".repeat(65536) } },
      {
        kind: "extension",
        record: record("foreign", scopeThreadRef(EnvironmentId.make("west"), ref.threadId)),
      },
      {
        kind: "extension",
        record: record("foreign", scopeThreadRef(ref.environmentId, ThreadId.make("other"))),
      },
    ];
    const migrated = migratePersistedRightPanelState({
      byThreadKey: {
        [scopedThreadKey(ref)]: {
          isOpen: true,
          activeSurfaceId: "old-id",
          surfaces: [
            { kind: "agents", id: "agents" },
            { ...valid, id: "old-id" },
            valid,
            ...malformed,
          ],
        },
      },
    });
    expect(migrated.byThreadKey[scopedThreadKey(ref)]).toEqual({
      isOpen: true,
      activeSurfaceId: valid.id,
      surfaces: [{ kind: "agents", id: "agents" }, valid],
    });
    const many = Array.from({ length: 70 }, (_, i) =>
      extensionPanelSurface(ref, record(String(i))),
    );
    expect(
      migratePersistedRightPanelState({
        byThreadKey: { [scopedThreadKey(ref)]: { isOpen: true, surfaces: many } },
      }).byThreadKey[scopedThreadKey(ref)]?.surfaces,
    ).toHaveLength(64);
  });

  it("normalizes current-version hydration and keeps unavailable plugin fallback serializable", async () => {
    const value = record();
    const valid = extensionPanelSurface(ref, value)!;
    const options = useRightPanelStore.persist.getOptions();
    if (!options.name) throw new Error("Missing persistence storage name");
    memory.setItem(
      options.name,
      JSON.stringify({
        version: options.version,
        state: {
          byThreadKey: {
            [scopedThreadKey(ref)]: {
              isOpen: true,
              activeSurfaceId: valid.id,
              surfaces: [
                valid,
                { kind: "extension", id: "bad", record: { ...value, version: 90 } },
              ],
            },
          },
        },
      }),
    );
    await useRightPanelStore.persist.rehydrate();
    expect(state().surfaces).toEqual([valid]);
    const serialized = await memory.getItem(options.name);
    if (serialized === null) throw new Error("Missing persisted record");
    const stored = JSON.parse(serialized);
    expect(stored.state.byThreadKey[scopedThreadKey(ref)].surfaces[0].record).toEqual(value);
    const host = createExtensionHost<string>({ authorize: () => false });
    const id = await host.restore(valid.record);
    expect(host.snapshot(id)).toMatchObject({
      status: "unavailable",
      record: { fallback: "Inventory is unavailable" },
    });
    host.dispose();
    const reopen = state().surfaces[0]!;
    useRightPanelStore.getState().closeSurface(ref, reopen.id);
    expect(state().isOpen).toBe(false);
    expect(useRightPanelStore.getState().openExtension(ref, valid.record)).toBe(true);
  });
});

it("saves inactive records without stealing focus, reopening the panel or defeating the user revision guard", () => {
  const store = useRightPanelStore.getState();
  store.openExtension(ref, record());
  store.open(ref, "agents");
  store.close(ref);
  const revision = store.getUserActionRevision(ref);
  expect(
    store.updateExtensionRecord(
      ref,
      { ...record(), restoreState: { selection: "saved" } },
      state().surfaces.find((entry) => entry.kind === "extension")?.viewerGeneration,
    ),
  ).toBe(true);
  expect(state().isOpen).toBe(false);
  expect(state().activeSurfaceId).toBe("agents");
  expect(store.getUserActionRevision(ref)).toBe(revision);
  expect(state().surfaces[0]).toMatchObject({ record: { restoreState: { selection: "saved" } } });
  expect(store.updateExtensionRecord(ref, record("not-open"))).toBe(false);
  const west = scopeThreadRef(EnvironmentId.make("west"), ref.threadId);
  expect(store.updateExtensionRecord(ref, record("resource", west))).toBe(false);
  const id = state().surfaces[0]!.id;
  store.closeSurface(ref, id);
  expect(store.updateExtensionRecord(ref, record())).toBe(false);
});
