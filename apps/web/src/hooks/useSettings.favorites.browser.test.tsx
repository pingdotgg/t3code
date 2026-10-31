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
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../test/render";

const state = vi.hoisted(() => ({
  catalog: null as unknown as Atom.Writable<{
    readonly isReady: boolean;
    readonly entries: ReadonlyMap<string, unknown>;
  }>,
  settings: new Map<string, unknown>(),
  connections: new Map<
    EnvironmentId,
    Atom.Writable<AsyncResult.AsyncResult<SupervisorConnectionState>>
  >(),
  persist: vi.fn(),
}));

vi.mock(import("~/connection/catalog"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  state.catalog = Atom.keepAlive(
    Atom.make<{ readonly isReady: boolean; readonly entries: ReadonlyMap<string, unknown> }>({
      isReady: true,
      entries: new Map(),
    }),
  );
  return {
    ...actual,
    environmentCatalog: {
      ...actual.environmentCatalog,
      catalogValueAtom: state.catalog as never,
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
      updateSettings: {
        ...actual.serverEnvironment.updateSettings,
        run: (_registry: unknown, input: unknown) => state.persist(input),
      } as never,
    },
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.persist) as never,
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  ensureClientSettingsHydrated,
  startModelPreferencesMigration,
  useToggleEnvironmentModelFavorite,
} from "./useSettings";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
const provider = ProviderInstanceId.make("codex_work");
const model = "gpt-6.1-sol";
const initialSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  favorites: [],
  providerModelPreferences: {},
} satisfies ServerSettings;
interface Write {
  environmentId: EnvironmentId;
  patch: ServerSettingsPatch;
  finish: (success?: boolean) => void;
}

const settingsAtom = (id: EnvironmentId) =>
  state.settings.get(id) as Atom.Writable<ServerSettings | null>;

function FavoriteEditor({
  environmentId,
  toggles,
  onClicked,
}: {
  environmentId: EnvironmentId;
  toggles: Array<() => Promise<void>>;
  onClicked: (pending: Promise<void>) => void;
}) {
  const toggle = useToggleEnvironmentModelFavorite(environmentId);
  const onClick = () => toggle(provider, model);
  toggles.push(onClick);
  return <button onClick={() => onClicked(onClick())}>Toggle favorite</button>;
}

async function setup() {
  await using stack = new AsyncDisposableStack();
  const registry = stack.adopt(AtomRegistry.make(), (registry) => registry.dispose());
  state.settings.clear();
  state.connections.clear();
  const durable = new Map<EnvironmentId, ServerSettings>();
  const toggles: Array<() => Promise<void>> = [];
  const writes: Write[] = [];
  let pendingClick: Promise<void> | undefined;
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

  const environment = stack.move();
  let screen: Screen | undefined;
  const show = async (ui: ReactNode) => {
    const tree = <RegistryContext.Provider value={registry}>{ui}</RegistryContext.Provider>;
    if (screen) await screen.rerender(tree);
    else screen = environment.use(await render(tree));
  };

  return {
    registry,
    durable,
    toggles,
    writes,
    show,
    mount: (environmentId = primaryId) =>
      show(
        <FavoriteEditor
          environmentId={environmentId}
          toggles={toggles}
          onClicked={(pending) => {
            pendingClick = pending;
          }}
        />,
      ),
    click(): Promise<void> {
      screen!.container.querySelector("button")!.click();
      return pendingClick!;
    },
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

describe("environment favorite toggles", () => {
  it.each([false, true])(
    "toggles twice before any server echo when initially favorited=%s",
    async (initiallyFavorited) => {
      await using fixture = await setup();
      const { registry, durable, writes, mount, click } = fixture;
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

  it("preserves an acknowledged add when a later remove fails before its echo", async () => {
    await using fixture = await setup();
    const { durable, writes, mount, click } = fixture;
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
    await using fixture = await setup();
    const { durable, writes, mount, click } = fixture;
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
    await using fixture = await setup();
    const { registry, durable, toggles, writes, mount } = fixture;
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

describe("legacy model preferences migration", () => {
  it.each(["succeeds", "fails"] as const)(
    "waits for connection and retries only after reconnect when the first save %s",
    async (outcome) => {
      await using _fixture = await setup();
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
      const connect = (id: EnvironmentId, generation: number) =>
        appAtomRegistry.set(
          state.connections.get(id)!,
          AsyncResult.success({
            ...AVAILABLE_CONNECTION_STATE,
            desired: true,
            generation,
            phase: "connected",
          }),
        );
      const pushSettings = (id = environmentId) =>
        appAtomRegistry.set(settingsAtom(id), { ...DEFAULT_SERVER_SETTINGS });
      const migration = (id: EnvironmentId) => ({
        environmentId: id,
        input: { patch: { migrateModelPreferences: { favorites: [{ provider, model }] } } },
      });

      appAtomRegistry.set(state.catalog, {
        isReady: true,
        entries: new Map([
          [environmentId, {}],
          [otherId, {}],
        ]),
      });
      using _migration = { [Symbol.dispose]: startModelPreferencesMigration() };
      await ensureClientSettingsHydrated();
      pushSettings();
      expect(state.persist).not.toHaveBeenCalled();

      connect(environmentId, 1);
      expect(state.persist).toHaveBeenCalledExactlyOnceWith(migration(environmentId));
      pushSettings();
      expect(state.persist).toHaveBeenCalledTimes(1);
      finishFirstSave();
      await firstSave;
      pushSettings();
      pushSettings();
      expect(state.persist).toHaveBeenCalledTimes(1);

      connect(otherId, 7);
      expect(state.persist).toHaveBeenLastCalledWith(migration(otherId));
      pushSettings(otherId);
      expect(state.persist).toHaveBeenCalledTimes(2);

      appAtomRegistry.set(
        state.connections.get(environmentId)!,
        AsyncResult.success({ ...AVAILABLE_CONNECTION_STATE, generation: 1 }),
      );
      pushSettings();
      expect(state.persist).toHaveBeenCalledTimes(2);
      connect(environmentId, 2);
      pushSettings();
      expect(state.persist.mock.calls).toEqual([
        [migration(environmentId)],
        [migration(otherId)],
        [migration(environmentId)],
      ]);
    },
  );
});
