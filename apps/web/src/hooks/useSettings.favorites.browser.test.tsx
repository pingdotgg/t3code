import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  connections: new Map<
    EnvironmentId,
    Atom.Writable<AsyncResult.AsyncResult<SupervisorConnectionState>>
  >(),
  persist: vi.fn(),
}));

vi.mock(import("~/connection/catalog"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentCatalog: {
      ...actual.environmentCatalog,
      stateAtom: ((id: EnvironmentId) => state.connections.get(id)) as never,
    },
  };
});
vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: async () => ({ favorites: [{ provider, model }] }),
    },
  }),
}));

vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      settingsValueAtom: ((id: EnvironmentId) => state.settings.get(id)) as never,
    },
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.persist) as never,
}));

import { useEnvironmentModelPreferences, useToggleEnvironmentModelFavorite } from "./useSettings";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
const provider = ProviderInstanceId.make("codex_work");
const model = "gpt-6.1-sol";
const initialSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  favorites: [],
  providerModelPreferences: {},
} satisfies ServerSettings;
let registry: AtomRegistry.AtomRegistry;
let root: Root;
let container: HTMLDivElement;
let durable: Map<EnvironmentId, ServerSettings>;
let toggles: Array<() => Promise<void>>;
let pendingClick: Promise<void> | undefined;
let writes: Array<{
  environmentId: EnvironmentId;
  patch: ServerSettingsPatch;
  finish: (success?: boolean) => void;
}>;

const settingsAtom = (id: EnvironmentId) =>
  state.settings.get(id) as Atom.Writable<ServerSettings | null>;

function FavoriteEditor({ environmentId }: { environmentId: EnvironmentId }) {
  const toggle = useToggleEnvironmentModelFavorite(environmentId);
  const onClick = () => toggle(provider, model);
  toggles.push(onClick);
  return <button onClick={() => void (pendingClick = onClick())}>Toggle favorite</button>;
}

function mount(environmentId = primaryId) {
  return act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <FavoriteEditor environmentId={environmentId} />
      </RegistryContext.Provider>,
    ),
  );
}

function click(): Promise<void> {
  container.querySelector("button")!.click();
  return pendingClick!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  state.settings.clear();
  state.connections.clear();
  durable = new Map();
  toggles = [];
  writes = [];
  for (const id of [primaryId, remoteId]) {
    state.settings.set(id, Atom.make<ServerSettings | null>(initialSettings));
    durable.set(id, initialSettings);
  }
  state.persist.mockReset().mockImplementation(
    ({
      environmentId,
      input,
    }: {
      environmentId: EnvironmentId;
      input: { patch: ServerSettingsPatch };
    }) =>
      new Promise((resolve) => {
        writes.push({
          environmentId,
          patch: input.patch,
          finish: (success = true) => {
            if (!success) {
              resolve(AsyncResult.failure(Cause.fail(new Error("save failed"))));
              return;
            }
            const settings = applyServerSettingsPatch(durable.get(environmentId)!, input.patch);
            durable.set(environmentId, settings);
            resolve(AsyncResult.success(settings));
          },
        });
      }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  registry.dispose();
  vi.unstubAllGlobals();
});

describe("environment favorite toggles", () => {
  it.each([false, true])(
    "toggles twice before any server echo when initially favorited=%s",
    async (initiallyFavorited) => {
      const favorites = initiallyFavorited ? [{ provider, model }] : [];
      const settings = { ...initialSettings, favorites };
      registry.set(settingsAtom(primaryId), settings);
      durable.set(primaryId, settings);
      await mount();
      const first = click();
      const second = click();
      await act(async () => {});
      expect(writes.map((write) => write.patch.setModelFavorites?.[0]?.favorite)).toEqual([
        !initiallyFavorited,
        initiallyFavorited,
      ]);
      writes[0]!.finish();
      await first;
      writes[1]!.finish();
      await second;
      expect(durable.get(primaryId)!.favorites).toEqual(favorites);
    },
  );

  it("keeps the newest pending intent when an earlier write completes", async () => {
    await mount();
    const first = click();
    const second = click();
    await act(async () => {});
    writes[0]!.finish();
    await first;
    const third = click();
    await act(async () => {});
    expect(writes.map((write) => write.patch.setModelFavorites?.[0]?.favorite)).toEqual([
      true,
      false,
      true,
    ]);
    writes[1]!.finish();
    await second;
    writes[2]!.finish();
    await third;
    expect(durable.get(primaryId)!.favorites).toEqual([{ provider, model }]);
  });

  it("clears failed intent so a retry still adds the favorite", async () => {
    await mount();
    const failed = click();
    await act(async () => {});
    writes[0]!.finish(false);
    await failed;
    const retry = click();
    await act(async () => {});
    writes[1]!.finish();
    await retry;
    expect(durable.get(primaryId)!.favorites).toEqual([{ provider, model }]);
  });

  it("toggles the acknowledged choice when the RPC reply precedes its server echo", async () => {
    await mount();
    const first = click();
    await act(async () => {});
    writes[0]!.finish();
    await first;
    expect(registry.get(settingsAtom(primaryId))!.favorites).toEqual([]);
    const second = click();
    await act(async () => {});
    writes[1]!.finish();
    await second;
    expect(durable.get(primaryId)!.favorites).toEqual([]);
  });

  it("uses a later remote change instead of a cached acknowledged choice", async () => {
    await mount();
    const first = click();
    await act(async () => {});
    writes[0]!.finish();
    await first;
    const remoteSettings = { ...initialSettings, favorites: [] };
    durable.set(primaryId, remoteSettings);
    await act(() => registry.set(settingsAtom(primaryId), remoteSettings));
    const second = click();
    await act(async () => {});
    writes[1]!.finish();
    await second;
    expect(durable.get(primaryId)!.favorites).toEqual([{ provider, model }]);
  });

  it("preserves an acknowledged add when a later remove fails before its echo", async () => {
    await mount();
    const first = click();
    await act(async () => {});
    writes[0]!.finish();
    await first;
    const failed = click();
    await act(async () => {});
    writes[1]!.finish(false);
    await failed;
    const retry = click();
    await act(async () => {});
    writes[2]!.finish();
    await retry;
    expect(durable.get(primaryId)!.favorites).toEqual([]);
  });

  it("does not reuse another environment's pending intent for the same model", async () => {
    await mount();
    const primary = click();
    await mount(remoteId);
    const remote = click();
    await act(async () => {});
    writes[0]!.finish();
    await primary;
    writes[1]!.finish();
    await remote;
    expect(durable.get(primaryId)!.favorites).toEqual([{ provider, model }]);
    expect(durable.get(remoteId)!.favorites).toEqual([{ provider, model }]);
  });

  it("reads the latest server state even when the click callback predates its echo", async () => {
    await mount();
    const previousClick = toggles.at(-1)!;
    const updated = { ...initialSettings, favorites: [{ provider, model }] };
    durable.set(primaryId, updated);
    await act(() => registry.set(settingsAtom(primaryId), updated));
    const clicked = previousClick();
    await act(async () => {});
    writes[0]!.finish();
    await clicked;
    expect(durable.get(primaryId)!.favorites).toEqual([]);
  });
});

function ModelPreferencesReader({ environmentId }: { environmentId: EnvironmentId }) {
  useEnvironmentModelPreferences(environmentId);
  return null;
}

describe("legacy model preferences migration", () => {
  it.each(["succeeds", "fails"] as const)(
    "waits for connection and retries only after reconnect when the first save %s",
    async (outcome) => {
      const environmentId = EnvironmentId.make(`migration-${outcome}`);
      const otherId = EnvironmentId.make(`other-${outcome}`);
      for (const id of [environmentId, otherId]) {
        state.settings.set(
          id,
          Atom.keepAlive(Atom.make<ServerSettings | null>(DEFAULT_SERVER_SETTINGS)),
        );
        state.connections.set(
          id,
          Atom.keepAlive(
            Atom.make<AsyncResult.AsyncResult<SupervisorConnectionState>>(
              AsyncResult.success(AVAILABLE_CONNECTION_STATE),
            ),
          ),
        );
      }
      let finishFirstSave = () => {};
      const firstSave = new Promise((resolve) => {
        finishFirstSave = () =>
          resolve(
            outcome === "succeeds"
              ? AsyncResult.success(DEFAULT_SERVER_SETTINGS)
              : AsyncResult.failure(Cause.fail(new Error("save failed"))),
          );
      });
      state.persist
        .mockReturnValueOnce(firstSave)
        .mockResolvedValue(AsyncResult.success(DEFAULT_SERVER_SETTINGS));
      const renderReader = (id = environmentId) =>
        act(() =>
          root.render(
            <RegistryContext.Provider value={registry}>
              <ModelPreferencesReader key={id} environmentId={id} />
            </RegistryContext.Provider>,
          ),
        );
      const connect = (id: EnvironmentId, generation: number) =>
        act(() =>
          registry.set(
            state.connections.get(id)!,
            AsyncResult.success({
              ...AVAILABLE_CONNECTION_STATE,
              desired: true,
              generation,
              phase: "connected",
            }),
          ),
        );
      const pushSettings = (id = environmentId) =>
        act(() => registry.set(settingsAtom(id), { ...DEFAULT_SERVER_SETTINGS }));
      const migration = (id: EnvironmentId) => ({
        environmentId: id,
        input: { patch: { migrateModelPreferences: { favorites: [{ provider, model }] } } },
      });

      await renderReader();
      await pushSettings();
      expect(state.persist).not.toHaveBeenCalled();

      await connect(environmentId, 1);
      expect(state.persist).toHaveBeenCalledExactlyOnceWith(migration(environmentId));
      await pushSettings();
      expect(state.persist).toHaveBeenCalledTimes(1);
      await act(finishFirstSave);
      await pushSettings();
      await pushSettings();
      expect(state.persist).toHaveBeenCalledTimes(1);

      await connect(otherId, 7);
      await pushSettings(otherId);
      expect(state.persist).toHaveBeenCalledTimes(1);
      await renderReader(otherId);
      expect(state.persist).toHaveBeenLastCalledWith(migration(otherId));
      await renderReader();
      await pushSettings();
      expect(state.persist).toHaveBeenCalledTimes(2);

      await act(() =>
        registry.set(
          state.connections.get(environmentId)!,
          AsyncResult.success({ ...AVAILABLE_CONNECTION_STATE, generation: 1 }),
        ),
      );
      await pushSettings();
      expect(state.persist).toHaveBeenCalledTimes(2);
      await connect(environmentId, 2);
      await pushSettings();
      expect(state.persist.mock.calls).toEqual([
        [migration(environmentId)],
        [migration(otherId)],
        [migration(environmentId)],
      ]);
    },
  );
});
