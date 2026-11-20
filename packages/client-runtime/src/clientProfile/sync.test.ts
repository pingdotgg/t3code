import { CLIENT_PROFILE_MAX_VALUE_BYTES } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { isClientProfileBaseKey, type ClientProfileSurface } from "./keys.ts";
import {
  emptyClientProfileSidecar,
  hashClientProfileValue as hash,
  type ClientProfileEntries,
  type ClientProfileEntry,
  type ClientProfileSidecar,
} from "./merge.ts";
import type { ClientProfileValueSource } from "./source.ts";
import { createClientProfileSync, type ClientProfileEnvironment } from "./sync.ts";

const M: ClientProfileSurface = { kind: "mobile" };
const D: ClientProfileSurface = { kind: "desktop", os: "mac" };
const DEBOUNCE = 300;
const DEVICE = "dev-a";

const entry = (value: unknown, changedAt: number, by: string): ClientProfileEntry => ({
  value,
  changedAt,
  by,
});

const env = (
  environmentId: string,
  document: ClientProfileEntries | undefined,
  overrides: Partial<ClientProfileEnvironment> = {},
): ClientProfileEnvironment => ({
  environmentId,
  label: environmentId.toUpperCase(),
  connected: true,
  supportsProfile: true,
  canWrite: true,
  document,
  ...overrides,
});

const syncingSidecar = (
  entries: ClientProfileSidecar["entries"] = {},
  highestSeen = 0,
): ClientProfileSidecar => ({
  deviceId: DEVICE,
  enabled: true,
  choicePending: false,
  highestSeen,
  entries,
});

function setup(input: {
  surface?: ClientProfileSurface;
  local: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  environments?: ReadonlyArray<ClientProfileEnvironment>;
  sidecar?: ClientProfileSidecar;
  now?: number;
  ready?: Promise<void>;
}) {
  vi.useFakeTimers();
  const surface = input.surface ?? M;
  const local = { ...input.local };
  const listeners = new Set<() => void>();
  const applied: Array<Readonly<Record<string, unknown>>> = [];
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const source: ClientProfileValueSource = {
    owns: (base) => isClientProfileBaseKey(base, surface),
    ready: () => input.ready ?? Promise.resolve(),
    read: () => ({ values: { ...local }, completePrefixes: [] }),
    defaults: () => input.defaults ?? {},
    apply: async (values) => {
      applied.push(values);
      let changed = false;
      for (const [base, value] of Object.entries(values)) {
        if (value === null ? base in local : local[base] !== value) changed = true;
        if (value === null) delete local[base];
        else local[base] = value;
      }
      if (changed) notify();
      return Object.fromEntries(
        Object.keys(values)
          .filter((base) => base in local)
          .map((base) => [base, local[base]]),
      );
    },
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
  const sidecarListeners = new Set<() => void>();
  const store = {
    sidecar: input.sidecar ?? emptyClientProfileSidecar(DEVICE),
    load: async () => store.sidecar,
    save: async (sidecar: ClientProfileSidecar) => {
      store.sidecar = sidecar;
    },
    subscribe: (onChange: () => void) => {
      sidecarListeners.add(onChange);
      return () => sidecarListeners.delete(onChange);
    },
  };
  const registry = AtomRegistry.make();
  const environmentsAtom = Atom.make<ReadonlyArray<ClientProfileEnvironment>>(
    input.environments ?? [],
  ).pipe(Atom.keepAlive);
  const pushes: Array<{ environmentId: string; entries: ClientProfileEntries }> = [];
  const errors: unknown[] = [];
  const clock = { now: input.now ?? 1_000 };
  const controller = createClientProfileSync({
    registry,
    environmentsAtom,
    push: async (environmentId, entries) => {
      pushes.push({ environmentId, entries });
    },
    surface,
    source,
    sidecarStore: store,
    now: () => clock.now,
    debounceMs: DEBOUNCE,
    onError: (cause) => errors.push(cause),
  });
  const stop = controller.start();
  return {
    controller,
    local,
    applied,
    store,
    pushes,
    errors,
    clock,
    status: () => registry.get(controller.statusAtom),
    setEnvironments: (next: ReadonlyArray<ClientProfileEnvironment>) =>
      registry.set(environmentsAtom, next),
    setLocal: (base: string, value: unknown) => {
      local[base] = value;
      notify();
    },
    changeSidecarElsewhere: (sidecar: ClientProfileSidecar) => {
      store.sidecar = sidecar;
      for (const listener of sidecarListeners) listener();
    },
    settle: () => vi.advanceTimersByTimeAsync(DEBOUNCE),
    [Symbol.dispose]: () => {
      stop();
      vi.useRealTimers();
      expect(errors).toEqual([]);
    },
  };
}

describe("createClientProfileSync", () => {
  it("seeds non-default values at zero when every server profile is empty", async () => {
    using t = setup({
      local: { themeMode: "dark", toolCallVisibility: "showAll" },
      defaults: { themeMode: "system", toolCallVisibility: "showAll" },
      environments: [env("e1", {})],
    });
    await t.controller.setEnabled(true);
    expect(t.pushes).toEqual([
      { environmentId: "e1", entries: { themeMode: entry("dark", 0, DEVICE) } },
    ]);
    expect(t.status()).toEqual({
      type: "syncing",
      environments: [{ environmentId: "e1", label: "E1" }],
    });
  });

  it('asks once when a profile exists and adopts synced values on "synced"', async () => {
    using t = setup({
      local: { themeMode: "dark" },
      environments: [env("e1", { themeMode: entry("light", 500, "dev-b") })],
    });
    await t.controller.setEnabled(true);
    expect(t.status()).toEqual({ type: "choice" });
    expect(t.applied).toEqual([]);
    expect(t.pushes).toEqual([]);

    await t.controller.choose("synced");
    expect(t.local.themeMode).toBe("light");
    expect(t.status()).toMatchObject({ type: "syncing" });
    await t.settle();
    expect(t.pushes.filter((push) => "themeMode" in push.entries)).toEqual([]);
  });

  it("shows the shared sidecar's state when another tab turns sync on, chooses or turns it off", async () => {
    using t = setup({
      local: { themeMode: "dark" },
      environments: [env("e1", { themeMode: entry("light", 500, "dev-b") })],
    });
    await t.settle();
    t.store.sidecar = { ...t.store.sidecar, enabled: true, choicePending: true };
    await t.controller.setEnabled(true);
    expect(t.status()).toEqual({ type: "choice" });

    t.store.sidecar = { ...t.store.sidecar, choicePending: false };
    await t.controller.choose("synced");
    expect(t.status()).toEqual({
      type: "syncing",
      environments: [{ environmentId: "e1", label: "E1" }],
    });

    t.changeSidecarElsewhere({ ...t.store.sidecar, enabled: false, entries: {} });
    await t.settle();
    expect(t.status()).toEqual({ type: "off" });
  });

  it("cancel turns sync off only while the choice is still open", async () => {
    using t = setup({
      local: { themeMode: "dark" },
      environments: [env("e1", { themeMode: entry("light", 500, "dev-b") })],
    });
    await t.controller.setEnabled(true);
    await t.controller.cancelChoice();
    expect(t.status()).toEqual({ type: "off" });

    await t.controller.setEnabled(true);
    t.store.sidecar = { ...t.store.sidecar, choicePending: false };
    await t.controller.cancelChoice();
    expect(t.store.sidecar.enabled).toBe(true);
    expect(t.status()).toMatchObject({ type: "syncing" });
  });

  it("\"thisDevice\" stamps every own key past the servers' stamps and leaves other surfaces' keys alone", async () => {
    using t = setup({
      local: { themeMode: "dark", toolCallVisibility: "showAll" },
      environments: [
        env("e1", {
          themeMode: entry("light", 500, "dev-b"),
          chatWidth: entry(720, 900, "dev-b"),
        }),
      ],
      now: 100,
    });
    await t.controller.setEnabled(true);
    await t.controller.choose("thisDevice");
    expect(t.pushes).toEqual([
      {
        environmentId: "e1",
        entries: {
          themeMode: entry("dark", 901, DEVICE),
          toolCallVisibility: entry("showAll", 901, DEVICE),
        },
      },
    ]);
    expect(t.local.themeMode).toBe("dark");
  });

  it("applying a remote value pushes nothing back", async () => {
    using t = setup({
      local: { themeMode: "dark" },
      environments: [env("e1", { themeMode: entry("dark", 10, DEVICE) })],
      sidecar: syncingSidecar({ themeMode: { changedAt: 10, by: DEVICE, hash: hash("dark") } }, 10),
    });
    await t.settle();
    expect(t.pushes).toEqual([]);

    t.setEnvironments([env("e1", { themeMode: entry("light", 2_000, "dev-b") })]);
    await t.settle();
    expect(t.local.themeMode).toBe("light");
    await t.settle();
    expect(t.pushes).toEqual([]);
  });

  it("relays a key the phone never applies from one server to another", async () => {
    const wordWrap = entry(720, 300, "dev-b");
    using t = setup({
      local: { themeMode: "system" },
      defaults: { themeMode: "system" },
      environments: [env("e1", { wordWrap }), env("e2", {})],
    });
    await t.controller.setEnabled(true);
    expect(t.pushes).toEqual([{ environmentId: "e2", entries: { wordWrap } }]);
    expect(t.applied.some((values) => "wordWrap" in values)).toBe(false);
  });

  it("coalesces a burst of local changes into one push", async () => {
    using t = setup({
      local: { themeLight: "a" },
      environments: [env("e1", { themeLight: entry("a", 10, DEVICE) })],
      sidecar: syncingSidecar({ themeLight: { changedAt: 10, by: DEVICE, hash: hash("a") } }, 10),
      now: 5_000,
    });
    await t.settle();
    expect(t.pushes).toEqual([]);

    t.setLocal("themeLight", "b");
    await vi.advanceTimersByTimeAsync(100);
    t.setLocal("themeLight", "c");
    await vi.advanceTimersByTimeAsync(100);
    t.setLocal("themeLight", "d");
    await vi.advanceTimersByTimeAsync(100);
    expect(t.pushes).toEqual([
      { environmentId: "e1", entries: { themeLight: entry("d", 5_000, DEVICE) } },
    ]);
  });

  it("starts again after it was stopped", async () => {
    using t = setup({
      local: { themeLight: "a" },
      environments: [env("e1", { themeLight: entry("a", 10, DEVICE) })],
      sidecar: syncingSidecar({ themeLight: { changedAt: 10, by: DEVICE, hash: hash("a") } }, 10),
      now: 5_000,
    });
    await t.settle();
    t.controller.start()();
    const stopAgain = t.controller.start();
    await t.settle();

    t.setLocal("themeLight", "b");
    await t.settle();
    stopAgain();
    expect(t.pushes).toEqual([
      { environmentId: "e1", entries: { themeLight: entry("b", 5_000, DEVICE) } },
    ]);
  });

  it("ignores environments that cannot write, lack the capability or have no profile yet", async () => {
    using t = setup({
      local: { themeMode: "dark" },
      defaults: { themeMode: "system" },
      environments: [
        env("e1", { themeMode: entry("light", 500, "dev-b") }, { canWrite: false }),
        env("e2", {}, { supportsProfile: false }),
        env("e3", undefined),
        env("e4", {}),
      ],
    });
    await t.controller.setEnabled(true);
    expect(t.status()).toEqual({
      type: "syncing",
      environments: [{ environmentId: "e4", label: "E4" }],
    });
    expect(t.pushes.map((push) => push.environmentId)).toEqual(["e4"]);
  });

  it("reports off, waiting, unsupported and syncing with the participating labels", async () => {
    using t = setup({ local: {} });
    await t.settle();
    expect(t.status()).toEqual({ type: "off" });

    await t.controller.setEnabled(true);
    expect(t.status()).toEqual({ type: "waiting" });

    const unsupported = env("e2", {}, { supportsProfile: false });
    t.setEnvironments([unsupported]);
    await t.settle();
    expect(t.status()).toEqual({ type: "unsupported" });

    t.setEnvironments([unsupported, env("e4", {}, { label: "Laptop" })]);
    await t.settle();
    expect(t.status()).toEqual({
      type: "syncing",
      environments: [{ environmentId: "e4", label: "Laptop" }],
    });
  });

  it("turning sync off forgets stamps but keeps the device id and highest stamp", async () => {
    using t = setup({
      local: { themeMode: "dark" },
      defaults: { themeMode: "system" },
      environments: [env("e1", { themeMode: entry("dark", 0, DEVICE) })],
      sidecar: syncingSidecar({ themeMode: { changedAt: 0, by: DEVICE, hash: hash("dark") } }, 40),
    });
    await t.settle();
    await t.controller.setEnabled(false);
    expect(t.store.sidecar).toEqual({
      deviceId: DEVICE,
      enabled: false,
      choicePending: false,
      highestSeen: 40,
      entries: {},
    });
    expect(t.status()).toEqual({ type: "off" });

    const before = t.pushes.length;
    t.setLocal("themeMode", "light");
    await t.settle();
    expect(t.pushes.length).toBe(before);
  });

  it("adopts an external change only when it is newer than the synced stamps", async () => {
    using t = setup({
      local: { themeLight: "a" },
      environments: [env("e1", { themeLight: entry("a", 500, "dev-b") })],
      sidecar: syncingSidecar(
        { themeLight: { changedAt: 500, by: "dev-b", hash: hash("a") } },
        500,
      ),
    });
    await t.settle();

    const change = (changedAt: number) =>
      t.controller.adoptExternalChange({
        environmentId: "e1",
        values: { themeLight: "b" },
        changedAt,
      });
    expect(await change(400)).toBe("older");
    expect(t.local.themeLight).toBe("a");
    expect(t.applied).toEqual([]);

    expect(await change(600)).toBe("applied");
    expect(t.local.themeLight).toBe("b");
    expect(t.pushes).toEqual([
      { environmentId: "e1", entries: { themeLight: entry("b", 600, DEVICE) } },
    ]);

    await t.controller.setEnabled(false);
    expect(await change(700)).toBe("off");
    await t.controller.setEnabled(true);
    expect(t.status()).toEqual({ type: "choice" });
    expect(await change(700)).toBe("waiting");
  });

  it("seeds a choice no profile needs before adopting an external change", async () => {
    using t = setup({ local: { themeLight: "a" }, environments: [env("e1", {})] });
    await t.settle();
    // Another tab turned sync on; this tab has not run a pass since.
    t.store.sidecar = { ...t.store.sidecar, enabled: true, choicePending: true };
    expect(
      await t.controller.adoptExternalChange({
        environmentId: "e1",
        values: { themeLight: "b" },
        changedAt: 2_000,
      }),
    ).toBe("applied");
    expect(t.local.themeLight).toBe("b");
  });

  it("drops oversize entries from pushes", async () => {
    using t = setup({
      surface: D,
      local: { "customTheme.big": "x".repeat(CLIENT_PROFILE_MAX_VALUE_BYTES), chatWidth: 800 },
      environments: [env("e1", {})],
      sidecar: syncingSidecar(
        {
          "customTheme.big": { changedAt: 5, by: DEVICE, hash: hash("small") },
          chatWidth: { changedAt: 5, by: DEVICE, hash: hash(720) },
        },
        5,
      ),
    });
    await t.settle();
    expect(t.pushes).toEqual([
      { environmentId: "e1", entries: { chatWidth: entry(800, 1_000, DEVICE) } },
    ]);
  });

  it("waits for the source before the first pass", async () => {
    const ready = Promise.withResolvers<void>();
    using t = setup({
      local: { themeMode: "dark" },
      environments: [env("e1", {})],
      sidecar: syncingSidecar({ themeMode: { changedAt: 5, by: DEVICE, hash: hash("light") } }, 5),
      ready: ready.promise,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.pushes).toEqual([]);
    expect(t.status()).toEqual({
      type: "syncing",
      environments: [{ environmentId: "e1", label: "E1" }],
    });

    ready.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.pushes).toEqual([
      { environmentId: "e1", entries: { themeMode: entry("dark", 1_000, DEVICE) } },
    ]);
  });

  it("shows syncing as soon as sync is turned on against servers without a profile", async () => {
    const ready = Promise.withResolvers<void>();
    using t = setup({ local: {}, environments: [env("e1", {})], ready: ready.promise });
    const turningOn = t.controller.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.status()).toEqual({
      type: "syncing",
      environments: [{ environmentId: "e1", label: "E1" }],
    });

    ready.resolve();
    await turningOn;
    expect(t.store.sidecar.choicePending).toBe(false);
  });

  it("reports a choice that fails instead of rejecting", async () => {
    const ready = Promise.withResolvers<void>();
    using t = setup({
      local: {},
      environments: [env("e1", { themeMode: entry("light", 500, "dev-b") })],
      sidecar: { ...emptyClientProfileSidecar(DEVICE), enabled: true, choicePending: true },
      ready: ready.promise,
    });
    const failure = new Error("unreadable");
    ready.reject(failure);
    await t.controller.choose("synced");
    expect(t.status()).toEqual({ type: "choice" });
    expect(t.errors.splice(0)).toEqual([failure, failure]);
  });

  it("skips a pass for environment updates that change nothing it uses", async () => {
    const e1 = env("e1", {});
    using t = setup({ local: {}, environments: [e1] });
    await t.settle();
    expect(vi.getTimerCount()).toBe(0);

    t.setEnvironments([{ ...e1 }]);
    expect(vi.getTimerCount()).toBe(0);

    t.setEnvironments([{ ...e1, label: "Renamed" }]);
    expect(vi.getTimerCount()).toBe(1);
  });
});
