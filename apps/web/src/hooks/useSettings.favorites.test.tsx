import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: new Map<EnvironmentId, Atom.Writable<ServerSettings | null>>(),
  persist: vi.fn(),
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: {
    settingsValueAtom: (id: EnvironmentId) => state.settings.get(id)!,
    updateSettings: Symbol("updateSettings"),
  },
  primaryServerSettingsAtom: undefined,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.persist }));
vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: { getClientSettings: async () => null } }),
}));

import { useToggleEnvironmentModelFavorite } from "./useSettings";

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
let renderer: ReactTestRenderer | undefined;
let durable: Map<EnvironmentId, ServerSettings>;
let writes: Array<{
  environmentId: EnvironmentId;
  patch: ServerSettingsPatch;
  finish: (success?: boolean) => void;
}>;

function FavoriteEditor({ environmentId }: { environmentId: EnvironmentId }) {
  const toggle = useToggleEnvironmentModelFavorite(environmentId);
  return <button onClick={() => toggle(provider, model)}>Toggle favorite</button>;
}

function editor(environmentId: EnvironmentId) {
  return (
    <RegistryContext.Provider value={registry}>
      <FavoriteEditor environmentId={environmentId} />
    </RegistryContext.Provider>
  );
}

async function mount(environmentId = primaryId) {
  await act(() => {
    renderer = create(editor(environmentId));
  });
}

function click(): Promise<void> {
  return renderer!.root.findByType("button").props.onClick();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  state.settings.clear();
  durable = new Map();
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
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  registry.dispose();
  vi.unstubAllGlobals();
});

describe("environment favorite toggles", () => {
  it.each([false, true])(
    "toggles twice before any server echo when initially favorited=%s",
    async (initiallyFavorited) => {
      const favorites = initiallyFavorited ? [{ provider, model }] : [];
      const settings = { ...initialSettings, favorites };
      registry.set(state.settings.get(primaryId)!, settings);
      durable.set(primaryId, settings);
      await mount();
      const first = click();
      const second = click();
      // Preparing the patch is asynchronous even when migration has already completed.
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
    expect(registry.get(state.settings.get(primaryId)!)!.favorites).toEqual([]);
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
    // Another client removed the favorite after this client's add was acknowledged.
    const remoteSettings = { ...initialSettings, favorites: [] };
    durable.set(primaryId, remoteSettings);
    await act(() => registry.set(state.settings.get(primaryId)!, remoteSettings));
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
    await act(() => renderer!.update(editor(remoteId)));
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
    const previousClick = renderer!.root.findByType("button").props.onClick as () => Promise<void>;
    const updated = { ...initialSettings, favorites: [{ provider, model }] };
    durable.set(primaryId, updated);
    await act(() => registry.set(state.settings.get(primaryId)!, updated));
    const clicked = previousClick();
    await act(async () => {});
    writes[0]!.finish();
    await clicked;
    expect(durable.get(primaryId)!.favorites).toEqual([]);
  });
});
