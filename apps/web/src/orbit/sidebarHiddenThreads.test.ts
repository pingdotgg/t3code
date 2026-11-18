// @effect-diagnostics globalTimers:off - The profile sync runs on plain promises, outside an Effect runtime.
import {
  createProfileSync,
  OrbitGatewayError,
  type OrbitGatewayNode,
  type OrbitGatewaySectionPatch,
  type OrbitGatewaySettings,
  type ProfileSyncState,
} from "@t3tools/client-runtime/orbit-gateway";
import * as Option from "effect/Option";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { create } from "zustand";

import { filterSidebarV2VisibleThreads } from "../components/Sidebar.logic";
import { useEnvironmentProvider } from "./environmentProvider";
import { createProviderRunGuard } from "./providerRunGuard";
import {
  hidesSidebarEnvironmentInventory,
  isSidebarHiddenThread,
} from "./sidebarHiddenThreads.logic";

const fixture = vi.hoisted(() => ({
  ids: 0,
  shells: new Map<string, unknown>(),
  shellListeners: new Map<string, Set<(value: unknown) => void>>(),
  /** The untrimmed read's answers per environment, in order; null is a failed read. */
  inventory: new Map<string, Array<string[] | null | Promise<string[] | null>>>(),
  inventoryReads: 0,
  /** The saved connections, as the environment catalog lists them. */
  catalog: new Map<string, { enabled: boolean; target: { _tag: string } }>(),
}));

vi.mock("../lib/utils", () => ({ randomUUID: () => `id-${++fixture.ids}` }));
vi.mock("./sidebarInventory", () => ({
  readSidebarThreadInventory: async (environmentId: string) => {
    fixture.inventoryReads += 1;
    const answers = fixture.inventory.get(environmentId) ?? [];
    const ids = (await (answers.length > 1 ? answers.shift() : answers[0])) ?? null;
    return ids?.map((id) => ({ id })) ?? null;
  },
}));
vi.mock("../state/shell", () => ({
  environmentShell: { stateValueAtom: (environmentId: string) => environmentId },
}));
vi.mock("../connection/catalog", () => ({ environmentCatalog: { catalogValueAtom: "catalog" } }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: string) =>
      atom === "catalog" ? { isReady: true, entries: fixture.catalog } : undefined,
    subscribe: (
      atom: string,
      listener: (value: unknown) => void,
      options?: { immediate?: boolean },
    ) => {
      const listeners = fixture.shellListeners.get(atom) ?? new Set();
      fixture.shellListeners.set(atom, listeners);
      listeners.add(listener);
      if (options?.immediate) {
        listener(fixture.shells.get(atom) ?? { status: "connecting", snapshot: Option.none() });
      }
      return () => listeners.delete(listener);
    },
  },
}));
vi.mock("./environmentProvider", () => ({
  useEnvironmentProvider: create(() => ({
    provider: "orbit",
    state: { disabledByOrbit: [], pairedByOrbit: ["clone"] },
    orbitInstances: {},
  })),
}));

function createLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

/** Each import is one window: its own module state over the shared localStorage. */
async function openWindow() {
  vi.resetModules();
  const module = await import("./sidebarHiddenThreads");
  const listeners: Array<(event: { key: string | null }) => void> = [];
  return { module, listeners };
}

function stubWindow(storage: Storage, windows: Array<Awaited<ReturnType<typeof openWindow>>>) {
  vi.stubGlobal("window", {
    localStorage: storage,
    addEventListener: (type: string, listener: (event: { key: string | null }) => void) => {
      if (type === "storage") windows.at(-1)?.listeners.push(listener);
    },
  });
}

function setup() {
  fixture.ids = 0;
  fixture.shells.clear();
  fixture.shellListeners.clear();
  fixture.inventory.clear();
  fixture.inventoryReads = 0;
  fixture.catalog.clear();
  useEnvironmentProvider.setState({ provider: "orbit" });
  const windows: Array<Awaited<ReturnType<typeof openWindow>>> = [];
  const storage = createLocalStorageStub();
  stubWindow(storage, windows);
  const open = async () => {
    const opened = await openWindow();
    windows.push(opened);
    opened.module.watchSidebarHiddenThreads();
    return opened;
  };
  /** The storage event the browser sends every other window after a write. */
  const broadcast = (from: Awaited<ReturnType<typeof openWindow>>) => {
    for (const other of windows) {
      if (other !== from) for (const listener of other.listeners) listener({ key: null });
    }
  };
  /** The profile's section was read once already. */
  const hydrate = (...profiles: number[]) => {
    for (const profile of profiles) {
      storage.setItem(`t3code:sidebar-hidden-threads:v2:agreed:${profile}`, "[]");
    }
  };
  /** Makes this device's storage the one `window` reads; another device has its own. */
  const use = () => stubWindow(storage, windows);
  return { storage, open, broadcast, hydrate, use };
}

/** Lets the sweep's microtask and its inventory read run. */
async function settle() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

const hidden = (
  window: Awaited<ReturnType<typeof openWindow>>,
  environmentId: string,
  id: string,
  createdAt?: string,
) =>
  isSidebarHiddenThread(window.module.useSidebarHiddenThreads.getState().marks, {
    environmentId,
    id,
    ...(createdAt ? { createdAt } : {}),
  });

/** The environment connects; its trimmed shell rows never feed the sweep. */
function liveShell(environmentId: string) {
  const value = { status: "live", snapshot: Option.some({ threads: [] }) };
  fixture.shells.set(environmentId, value);
  for (const listener of fixture.shellListeners.get(environmentId) ?? []) listener(value);
}

/**
 * What the real Gateway stores for the section: null and an empty list both become
 * an explicit `{schema: 1, threads: []}`; a bare list, blank refs or `threads` as a map are 422.
 */
function storedThreadRefs(value: unknown): {
  schema: number;
  threads: { environmentId: string; threadId: string }[];
} {
  const refuse = (why: string): never => {
    throw new OrbitGatewayError({
      code: "validation.failed",
      message: why,
      status: 422,
      details: {},
    });
  };
  if (value === null) return { schema: 1, threads: [] };
  if (typeof value !== "object" || Array.isArray(value)) return refuse("not an object");
  const { schema, threads } = value as { schema?: unknown; threads?: unknown };
  if (typeof schema !== "number" || !Number.isInteger(schema) || schema < 1 || schema > 1000) {
    return refuse("unknown schema");
  }
  if (!Array.isArray(threads)) return refuse("threads must be a list");
  if (threads.length === 0) return { schema: 1, threads: [] };
  // The Gateway's PHP regexes: ASCII whitespace only, lengths in UTF-8 bytes.
  const ref = (value: unknown, colon: boolean) =>
    typeof value === "string" &&
    (colon ? /^[^ \t\n\v\f\r:]+$/ : /^[^ \t\n\v\f\r]+$/).test(value) &&
    new TextEncoder().encode(value).length <= 255;
  const seen = new Set<string>();
  return {
    schema,
    threads: threads.map((entry: unknown) => {
      const { environmentId, threadId } = (entry ?? {}) as Record<string, unknown>;
      if (!ref(environmentId, true) || !ref(threadId, false)) refuse("bad ref");
      const key = `${environmentId as string}:${threadId as string}`;
      if (seen.has(key)) refuse("duplicate ref");
      seen.add(key);
      return { environmentId: environmentId as string, threadId: threadId as string };
    }),
  };
}

/** A Gateway profile with only the hidden-threads section, which checks versions. */
function fakeGateway(initial: string[] = []) {
  const gateway = {
    version: initial.length > 0 ? 1 : 0,
    value:
      initial.length > 0
        ? {
            schema: 1,
            threads: initial.map((key) => {
              const [environmentId, threadId] = key.split(":");
              return { environmentId, threadId };
            }),
          }
        : null,
    patches: [] as Record<string, OrbitGatewaySectionPatch>[],
    beforeSettings: null as Promise<void> | null,
    beforePatch: null as Promise<void> | null,
    onPatch: null as (() => void) | null,
    /** An old Gateway that refuses the section (422). */
    refuse: false,
    /** A reply that leaves the section out, though the write landed. */
    omitReply: false,
    /** A reply with the section's version but without its value, or with a malformed one. */
    replyValue: "written" as "written" | "absent" | "malformed",
    omitRead: false,
  };
  const read = (): OrbitGatewaySettings => ({
    profileId: 1,
    version: gateway.version,
    workspaces: [],
    updatedAt: "",
    document: gateway.value ? { sidebarHiddenThreads: gateway.value } : {},
    // A section the profile never wrote is absent from the reply: version 0.
    sections:
      gateway.version > 0
        ? { sidebarHiddenThreads: { version: gateway.version, updatedAt: null, updatedBy: "" } }
        : {},
  });
  const client = {
    settings: async () => {
      await gateway.beforeSettings;
      const settings = read();
      return gateway.omitRead ? { ...settings, document: {} } : settings;
    },
    patchSections: async (_id: number, patch: Record<string, OrbitGatewaySectionPatch>) => {
      gateway.patches.push(patch);
      gateway.onPatch?.();
      await gateway.beforePatch;
      if (gateway.refuse) {
        throw new OrbitGatewayError({
          code: "validation_failed",
          message: "unknown section",
          status: 422,
          details: {},
        });
      }
      const section = patch.sidebarHiddenThreads!;
      const stored = storedThreadRefs(section.value);
      if (section.version !== gateway.version) {
        throw new OrbitGatewayError({
          code: "conn.settings_version_conflict",
          message: "stale",
          status: 409,
          details: { sections: { sidebarHiddenThreads: gateway.version } },
        });
      }
      gateway.version += 1;
      gateway.value = stored;
      if (gateway.omitReply) return { ...read(), document: {}, sections: {} };
      if (gateway.replyValue === "absent") return { ...read(), document: {} };
      if (gateway.replyValue === "malformed") {
        return {
          ...read(),
          document: { sidebarHiddenThreads: { schema: 1, threads: [{ environmentId: "clone" }] } },
        };
      }
      return read();
    },
  };
  const me = (): OrbitGatewayNode =>
    ({ profile: { id: 1, name: "Nick", settingsVersion: gateway.version } }) as OrbitGatewayNode;
  return { gateway, client, me };
}

/** What the main window's profile sync does for this section. */
function mainSync(
  window: Awaited<ReturnType<typeof openWindow>>,
  fake: ReturnType<typeof fakeGateway>,
  clock = { now: 0 },
) {
  let state: ProfileSyncState | null = null;
  const channel = window.module.sidebarHiddenThreadsChannel(1);
  const engine = createProfileSync({
    client: fake.client,
    channels: () => [channel],
    loadState: () => state,
    saveState: (next) => {
      state = next;
    },
    now: () => clock.now,
  });
  return Object.assign(
    () => {
      window.module.bindSidebarHiddenProfile(1);
      return engine.run(fake.me());
    },
    { channel },
  );
}

const ref = (threadId: string) => ({ environmentId: "clone", threadId });
const threads = (fake: ReturnType<typeof fakeGateway>) =>
  (fake.gateway.value?.threads ?? []).map((entry) => entry.threadId);
const opsOf = (storage: Storage) =>
  Array.from({ length: storage.length }, (_, index) => storage.key(index)!).filter((key) =>
    key.includes(":op:"),
  );

describe("sidebar hidden threads store", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a fresh client's Orbit rows out until its profile's marks arrive", async () => {
    const { open } = setup();
    const main = await open();
    const fake = fakeGateway(["clone:hidden"]);
    let release!: () => void;
    fake.gateway.beforeSettings = new Promise((resolve) => (release = resolve));
    // First paint, nothing bound: the Orbit environment waits, the local one is usable.
    expect(hidden(main, "clone", "hidden")).toBe(true);
    expect(hidden(main, "clone", "visible")).toBe(true);
    expect(hidden(main, "local", "mine")).toBe(false);

    const run = mainSync(main, fake)();
    // Bound, but the profile's section has not been read yet.
    expect(hidden(main, "clone", "visible")).toBe(true);
    release();
    await run;
    expect(hidden(main, "clone", "hidden")).toBe(true);
    expect(hidden(main, "clone", "visible")).toBe(false);
    expect(fake.gateway.patches).toHaveLength(0);
  });

  it("keeps two windows' Disconnects, and an edit made while the write is in flight", async () => {
    const { open, broadcast } = setup();
    const main = await open();
    const extra = await open();
    const fake = fakeGateway();
    const sync = mainSync(main, fake);
    await sync();
    broadcast(main);

    main.module.hideSidebarThread({ environmentId: "clone", threadId: "x" });
    extra.module.hideSidebarThread({ environmentId: "clone", threadId: "y" });
    broadcast(extra);
    let release!: () => void;
    fake.gateway.beforePatch = new Promise((resolve) => (release = resolve));
    const patched = new Promise<void>((resolve) => (fake.gateway.onPatch = resolve));
    const run = sync();
    await patched;
    // The user shows x again while the write that hides it is in flight.
    extra.module.showSidebarThread({ environmentId: "clone", threadId: "x" });
    release();
    await run;
    expect(fake.gateway.value?.threads).toEqual([
      { environmentId: "clone", threadId: "x" },
      { environmentId: "clone", threadId: "y" },
    ]);
    broadcast(main);
    expect(hidden(main, "clone", "x")).toBe(false);
    expect(hidden(extra, "clone", "y")).toBe(true);
    fake.gateway.beforePatch = null;
    await sync();
    expect(fake.gateway.value?.threads).toEqual([{ environmentId: "clone", threadId: "y" }]);
  });

  it("lets an extra window follow the main window's profile, without writing it back", async () => {
    const { open, broadcast, storage } = setup();
    const main = await open();
    const extra = await open();
    main.module.bindSidebarHiddenProfile(1);
    broadcast(main);
    main.module.bindSidebarHiddenProfile(2);
    broadcast(main);
    extra.module.hideSidebarThread({ environmentId: "clone", threadId: "x" });
    expect(extra.module.useSidebarHiddenThreads.getState().active).toBe("2");
    expect(storage.getItem("t3code:sidebar-hidden-threads:v2:active")).toBe('"2"');
    expect(storage.getItem("t3code:sidebar-hidden-threads:v2:op:2:clone:x")).not.toBeNull();
    // Orbit mode off: every window unbinds and the profile's marks no longer apply.
    useEnvironmentProvider.setState({ provider: "default" });
    main.module.bindSidebarHiddenProfile("off");
    broadcast(main);
    expect(hidden(extra, "clone", "x")).toBe(false);
  });

  it("keeps a pairing this client cannot place yet waiting, and frees one Orbit did not claim", async () => {
    const { open } = setup();
    const main = await open();
    // A fresh client: the saved pairing is in the catalog, its Orbit metadata is not.
    useEnvironmentProvider.setState({ state: { disabledByOrbit: [], pairedByOrbit: [] } });
    fixture.catalog.set("paired", { enabled: true, target: { _tag: "BearerConnectionTarget" } });
    fixture.catalog.set("other", { enabled: true, target: { _tag: "BearerConnectionTarget" } });
    fixture.catalog.set("ssh", { enabled: true, target: { _tag: "SshConnectionTarget" } });
    fixture.catalog.set("off", { enabled: false, target: { _tag: "BearerConnectionTarget" } });
    for (const listener of fixture.shellListeners.get("catalog") ?? []) listener(null);
    expect(hidden(main, "paired", "row")).toBe(true);
    expect(hidden(main, "other", "row")).toBe(true);
    expect(hidden(main, "ssh", "row")).toBe(false);
    expect(hidden(main, "off", "row")).toBe(false);
    // The Gateway's listing claims "paired" only.
    main.module.classifySidebarEnvironments(["paired"]);
    expect(hidden(main, "paired", "row")).toBe(true);
    expect(hidden(main, "other", "row")).toBe(false);
    // The profile's marks arrive: only marked rows stay hidden.
    const fake = fakeGateway(["paired:hidden"]);
    await mainSync(main, fake)();
    expect(hidden(main, "paired", "row")).toBe(false);
    expect(hidden(main, "paired", "hidden")).toBe(true);
    useEnvironmentProvider.setState({ state: { disabledByOrbit: [], pairedByOrbit: ["clone"] } });
  });

  it("carries a peek made before the first bind to that profile", async () => {
    const { open, hydrate } = setup();
    hydrate(1);
    const main = await open();
    const peek = main.module.beginSidebarPeek(
      { environmentId: "clone", threadId: "target" },
      { targetListed: false, environmentSurfaced: false },
    );
    main.module.bindSidebarHiddenProfile(1);
    expect(hidden(main, "clone", "target")).toBe(true);
    peek.commit();
    expect(main.module.useSidebarHiddenThreads.getState().marks.keys.has("clone:target")).toBe(
      true,
    );
  });

  it("marks every sibling of a peek per thread, so a second device hides older pages too", async () => {
    const fake = fakeGateway();
    const deviceA = setup();
    const a = await deviceA.open();
    const syncA = mainSync(a, fake);
    await syncA();
    const peek = a.module.beginSidebarPeek(ref("target"), {
      targetListed: false,
      environmentSurfaced: true,
    });
    peek.commit();
    a.module.showSidebarThread(ref("shown"));
    // The untrimmed read has what the first trimmed shell leaves out.
    fixture.inventory.set("clone", [["target", "shown", "recent", "older-settled", "idle-child"]]);
    liveShell("clone");
    await settle();
    expect(fixture.inventoryReads).toBe(1);
    // The hold went, so a thread created later shows like any other.
    expect(a.module.useSidebarHiddenThreads.getState().marks.environments.size).toBe(0);
    expect(hidden(a, "clone", "created-later")).toBe(false);
    expect(hidden(a, "clone", "shown")).toBe(false);
    await syncA();
    expect(threads(fake)).toEqual(["target", "recent", "older-settled", "idle-child"]);

    // Device B never peeked: it hydrates the per-thread marks only.
    const deviceB = setup();
    const b = await deviceB.open();
    const syncB = mainSync(b, fake);
    await syncB();
    const marksB = b.module.useSidebarHiddenThreads.getState().marks;
    // B's shelf pages the environment, and an older page's row stays hidden.
    expect(hidesSidebarEnvironmentInventory(marksB, "clone")).toBe(false);
    const page = ["older-settled", "idle-child", "shown"].map((id) => ({
      environmentId: "clone",
      id,
      archivedAt: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    }));
    const listed = (marks: typeof marksB) =>
      filterSidebarV2VisibleThreads(
        page as unknown as Parameters<typeof filterSidebarV2VisibleThreads>[0],
        null,
        new Set(),
        marks,
      ).map((row) => row.id);
    expect(listed(marksB)).toEqual(["shown"]);

    // B's Orbit panel Show lists exactly that row on both devices.
    b.module.showSidebarThread(ref("older-settled"));
    expect(listed(b.module.useSidebarHiddenThreads.getState().marks)).toEqual([
      "older-settled",
      "shown",
    ]);
    await syncB();
    expect(threads(fake)).toEqual(["target", "recent", "idle-child"]);
    deviceA.use();
    await syncA();
    expect(listed(a.module.useSidebarHiddenThreads.getState().marks)).toEqual([
      "older-settled",
      "shown",
    ]);
    expect(hidden(a, "clone", "recent")).toBe(true);
  });

  it("finishes a peek whose extra window closed during the read, in the main window", async () => {
    const { open, broadcast } = setup();
    const main = await open();
    const extra = await open();
    const fake = fakeGateway();
    const sync = mainSync(main, fake);
    await sync();
    broadcast(main);
    extra.module
      .beginSidebarPeek(ref("target"), { targetListed: false, environmentSurfaced: true })
      .commit();
    // The extra window closes before its environment connects: its sweep goes with it.
    fixture.shellListeners.clear();
    broadcast(extra);
    expect(hidden(main, "clone", "older")).toBe(true);
    fixture.inventory.set("clone", [["target", "older", "idle-child"]]);
    liveShell("clone");
    await settle();
    expect(fixture.inventoryReads).toBe(1);
    expect(main.module.useSidebarHiddenThreads.getState().marks.environments.size).toBe(0);
    expect(hidden(main, "clone", "created-later")).toBe(false);
    await sync();
    expect(threads(fake)).toEqual(["target", "older", "idle-child"]);
    // Another storage event finds no hold: no second read.
    broadcast(extra);
    liveShell("clone");
    await settle();
    expect(fixture.inventoryReads).toBe(1);
  });

  it("holds through failed and slow inventory reads, and a show during the read wins", async () => {
    vi.useFakeTimers();
    const { open } = setup();
    const main = await open();
    const fake = fakeGateway();
    const sync = mainSync(main, fake);
    await sync();
    main.module
      .beginSidebarPeek(ref("target"), { targetListed: false, environmentSurfaced: true })
      .commit();
    let answer!: (ids: string[]) => void;
    const slow = new Promise<string[]>((resolve) => (answer = resolve));
    fixture.inventory.set("clone", [null, slow]);
    liveShell("clone");
    liveShell("clone");
    await settle();
    expect(fixture.inventoryReads).toBe(1);
    expect(hidden(main, "clone", "anything")).toBe(true);
    // One retry after the pause, not one per shell update.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.inventoryReads).toBe(2);
    main.module.showSidebarThread(ref("sibling"));
    answer(["target", "sibling", "other"]);
    await settle();
    expect(hidden(main, "clone", "sibling")).toBe(false);
    expect(hidden(main, "clone", "other")).toBe(true);
    await sync();
    expect(threads(fake)).toEqual(["target", "other"]);
    vi.useRealTimers();
  });

  it("lets a show beat a provisional hide before the peek resolves, through commit and rollback", async () => {
    const { open, hydrate, storage } = setup();
    hydrate(1);
    const main = await open();
    main.module.bindSidebarHiddenProfile(1);
    const committed = main.module.beginSidebarPeek(ref("a"), {
      targetListed: false,
      environmentSurfaced: false,
    });
    const cancelled = main.module.beginSidebarPeek(ref("b"), {
      targetListed: false,
      environmentSurfaced: false,
    });
    expect(hidden(main, "clone", "a")).toBe(true);
    main.module.showSidebarThread(ref("a"));
    main.module.showSidebarThread(ref("b"));
    expect(hidden(main, "clone", "a")).toBe(false);
    expect(hidden(main, "clone", "b")).toBe(false);
    committed.commit();
    cancelled.cancel();
    expect(hidden(main, "clone", "a")).toBe(false);
    expect(hidden(main, "clone", "b")).toBe(false);
    expect(opsOf(storage).map((key) => JSON.parse(storage.getItem(key)!).intent)).toEqual([
      "show",
      "show",
    ]);
  });

  it("recovers a peek its closed window left, never a live window's", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { open, storage } = setup();
    storage.setItem("t3code:sidebar-hidden-threads:v2:agreed:1", "[]");
    // A window that crashed while preparing, before this restart.
    storage.setItem(
      "t3code:sidebar-hidden-threads:v2:attempt:gone",
      JSON.stringify({
        profile: "1",
        environmentId: "clone",
        target: "clone:orphan",
        hold: true,
        committed: false,
        shown: [],
        owner: "window-gone",
        beat: 0,
      }),
    );
    storage.setItem("t3code:sidebar-hidden-threads:v2:active", '"1"');
    const restarted = await open();
    const other = await open();
    other.module.beginSidebarPeek(ref("live"), {
      targetListed: false,
      environmentSurfaced: false,
    });
    expect(hidden(restarted, "clone", "orphan")).toBe(true);
    await vi.advanceTimersByTimeAsync(95_000);
    expect(storage.getItem("t3code:sidebar-hidden-threads:v2:attempt:gone")).toBeNull();
    expect(hidden(restarted, "clone", "orphan")).toBe(false);
    expect(hidden(restarted, "clone", "unrelated")).toBe(false);
    // The other window still prepares its peek: its provisional hide stays.
    expect(hidden(other, "clone", "live")).toBe(true);
    vi.useRealTimers();
  });

  it("keeps only fitting hides in the profile, and lets shows sync past the rest", async () => {
    const full = Array.from({ length: 500 }, (_, index) => `clone:t${index}`);
    const { open, storage } = setup();
    const main = await open();
    const fake = fakeGateway(full);
    const sync = mainSync(main, fake);
    await sync();
    main.module.hideSidebarThread(ref("x"));
    main.module.hideSidebarThread(ref("y"));
    main.module.showSidebarThread(ref("t0"));
    await sync();
    expect(threads(fake)).toHaveLength(500);
    expect(threads(fake)).not.toContain("t0");
    expect(threads(fake).at(-1)).toBe("x");
    expect(sync.channel.overflow()?.rows).toBe(501);
    // y stays hidden here and waits; another run sends nothing new.
    expect(hidden(main, "clone", "y")).toBe(true);
    expect(opsOf(storage)).toEqual(["t3code:sidebar-hidden-threads:v2:op:1:clone:y"]);
    const patches = fake.gateway.patches.length;
    await sync();
    expect(fake.gateway.patches).toHaveLength(patches);
    // A show frees a row: the waiting hide goes out and the error clears.
    main.module.showSidebarThread(ref("t1"));
    await sync();
    expect(threads(fake)).toContain("y");
    expect(sync.channel.overflow()).toBeNull();
    expect(opsOf(storage)).toEqual([]);
  });

  it("retries a refused section at the probe pace, and trusts only a confirmed write", async () => {
    const { open, storage } = setup();
    const main = await open();
    const fake = fakeGateway();
    const clock = { now: 0 };
    const sync = mainSync(main, fake, clock);
    await sync();
    fake.gateway.refuse = true;
    main.module.hideSidebarThread(ref("x"));
    await expect(sync()).rejects.toMatchObject({ status: 422 });
    // Upgraded meanwhile; the refusal stays visible until the pause ends.
    fake.gateway.refuse = false;
    await expect(sync()).rejects.toMatchObject({ status: 422 });
    expect(fake.gateway.patches).toHaveLength(1);
    clock.now = 30_000;
    // The write lands, but the reply leaves the section out: the op stays.
    fake.gateway.omitReply = true;
    await expect(sync()).rejects.toThrow(/did not confirm/);
    expect(opsOf(storage)).toHaveLength(1);
    // A fresh read that holds the same value retires it, without another write.
    fake.gateway.omitReply = false;
    await sync();
    expect(opsOf(storage)).toEqual([]);
    expect(fake.gateway.patches).toHaveLength(2);
    expect(threads(fake)).toEqual(["x"]);
    // The last mark goes: the empty set lands, but a reply without it or with a malformed one
    // confirms nothing, so the show stays until a read shows the empty set.
    for (const replyValue of ["absent", "malformed"] as const) {
      fake.gateway.replyValue = "written";
      main.module.hideSidebarThread(ref("x"));
      await sync();
      main.module.showSidebarThread(ref("x"));
      fake.gateway.replyValue = replyValue;
      await expect(sync()).rejects.toThrow(/did not confirm/);
      expect(opsOf(storage)).toHaveLength(1);
      expect(hidden(main, "clone", "x")).toBe(false);
      const patches = fake.gateway.patches.length;
      fake.gateway.omitRead = true;
      await expect(sync()).rejects.toThrow(/did not confirm/);
      expect(opsOf(storage)).toHaveLength(1);
      expect(fake.gateway.patches).toHaveLength(patches);
      // Only an explicit empty set retires the show.
      fake.gateway.omitRead = false;
      await sync();
      expect(fake.gateway.patches).toHaveLength(patches);
      expect(opsOf(storage)).toEqual([]);
      expect(threads(fake)).toEqual([]);
      expect(hidden(main, "clone", "x")).toBe(false);
    }
  });

  it("binds nothing from a /me that answered across Orbit off and on", async () => {
    const { open, storage } = setup();
    const main = await open();
    const guard = createProviderRunGuard();
    // Confirmed unbound earlier: no profile.
    main.module.bindSidebarHiddenProfile(null);
    expect(hidden(main, "clone", "row")).toBe(false);
    const stale = guard.begin();
    useEnvironmentProvider.setState({ provider: "default" });
    main.module.bindSidebarHiddenProfile("off");
    useEnvironmentProvider.setState({ provider: "orbit" });
    // On again: a fresh bind is pending, so Orbit rows wait instead of reading "none" as known.
    expect(hidden(main, "clone", "row")).toBe(true);
    // The delayed reply of the run from before the switch applies nothing.
    expect(stale()).toBe(false);
    expect(storage.getItem("t3code:sidebar-hidden-threads:v2:active")).toBe('"off"');
    const fresh = guard.begin();
    expect(fresh()).toBe(true);
    storage.setItem("t3code:sidebar-hidden-threads:v2:agreed:1", '["clone:hidden"]');
    main.module.bindSidebarHiddenProfile(1);
    expect(hidden(main, "clone", "row")).toBe(false);
    expect(hidden(main, "clone", "hidden")).toBe(true);
    // Off and on again offline: the bound profile's cached marks apply at once.
    useEnvironmentProvider.setState({ provider: "default" });
    main.module.bindSidebarHiddenProfile("off");
    expect(hidden(main, "clone", "hidden")).toBe(false);
    useEnvironmentProvider.setState({ provider: "orbit" });
    expect(hidden(main, "clone", "hidden")).toBe(true);
    expect(hidden(main, "clone", "row")).toBe(false);
  });

  it("cancels only its own peek, and drops a peek whose profile was left", async () => {
    const { open, hydrate } = setup();
    hydrate(1, 2);
    const main = await open();
    main.module.bindSidebarHiddenProfile(1);
    const first = main.module.beginSidebarPeek(
      { environmentId: "clone", threadId: "a" },
      { targetListed: false, environmentSurfaced: true },
    );
    const second = main.module.beginSidebarPeek(
      { environmentId: "clone", threadId: "b" },
      { targetListed: false, environmentSurfaced: true },
    );
    first.cancel();
    expect(hidden(main, "clone", "a")).toBe(true);
    expect(hidden(main, "clone", "unrelated")).toBe(true);
    main.module.bindSidebarHiddenProfile(2);
    second.commit();
    main.module.bindSidebarHiddenProfile(1);
    expect(main.module.useSidebarHiddenThreads.getState().marks.keys.size).toBe(0);
    expect(hidden(main, "clone", "unrelated")).toBe(false);
  });

  it("peeks at a loaded thread the scoped sidebar does not list", async () => {
    const { open, hydrate } = setup();
    hydrate(1);
    const main = await open();
    main.module.bindSidebarHiddenProfile(1);
    main.module.publishSidebarListedThreads(new Set(["clone:in-scope"]));
    expect(main.module.isSidebarListedNow("clone", "in-scope")).toBe(true);
    expect(main.module.isSidebarListedNow("clone", "other-project")).toBe(false);
    const peek = main.module.beginSidebarPeek(
      { environmentId: "clone", threadId: "other-project" },
      {
        targetListed: main.module.isSidebarListedNow("clone", "other-project"),
        environmentSurfaced: false,
      },
    );
    peek.commit();
    expect(hidden(main, "clone", "other-project")).toBe(true);
    expect(hidden(main, "clone", "in-scope")).toBe(false);
  });
});
