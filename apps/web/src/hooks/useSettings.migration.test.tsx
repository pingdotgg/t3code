import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const settingsFromServerWithoutMigration = DEFAULT_SERVER_SETTINGS;

const state = vi.hoisted(() => ({
  settings: undefined as unknown as Atom.Writable<ServerSettings | null>,
  connection: undefined as unknown as Atom.Writable<
    AsyncResult.AsyncResult<SupervisorConnectionState>
  >,
  persist: vi.fn(),
}));

vi.mock("~/connection/catalog", () => ({
  environmentCatalog: { stateAtom: () => state.connection },
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: {
    settingsValueAtom: () => state.settings,
    updateSettings: Symbol("updateSettings"),
  },
  primaryServerSettingsAtom: undefined,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.persist }));
vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: async () => ({
        favorites: [{ provider: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" }],
      }),
    },
  }),
}));

import { useEnvironmentModelPreferences } from "./useSettings";

function ModelPicker(props: { readonly environmentId: EnvironmentId }) {
  useEnvironmentModelPreferences(props.environmentId);
  return null;
}

let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  state.settings = Atom.make<ServerSettings | null>(settingsFromServerWithoutMigration);
  state.connection = Atom.make<AsyncResult.AsyncResult<SupervisorConnectionState>>(
    AsyncResult.success(connected(1)),
  );
  state.persist
    .mockReset()
    .mockResolvedValue(AsyncResult.success(settingsFromServerWithoutMigration));
});

function connected(generation: number): SupervisorConnectionState {
  return { ...AVAILABLE_CONNECTION_STATE, desired: true, phase: "connected", generation };
}

async function renderModelPicker(environmentId: EnvironmentId) {
  await act(async () => {
    renderer = create(
      <RegistryContext.Provider value={registry}>
        <ModelPicker environmentId={environmentId} />
      </RegistryContext.Provider>,
    );
  });
}

async function pushSettings(count: number) {
  for (let push = 0; push < count; push += 1) {
    await act(async () => registry.set(state.settings, { ...settingsFromServerWithoutMigration }));
  }
}

afterEach(async () => {
  await act(() => renderer?.unmount());
  registry.dispose();
  vi.unstubAllGlobals();
});

it("migrates once when the server drops the migration and keeps pushing settings", async () => {
  const environmentId = EnvironmentId.make("remote");
  await renderModelPicker(environmentId);
  await pushSettings(3);
  expect(state.persist).toHaveBeenCalledTimes(1);
  expect(state.persist).toHaveBeenCalledWith({
    environmentId,
    input: {
      patch: {
        migrateModelPreferences: {
          favorites: [{ provider: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" }],
        },
      },
    },
  });
});

it("migrates again after the environment reconnects", async () => {
  await renderModelPicker(EnvironmentId.make("upgraded"));
  await pushSettings(2);
  await act(async () => registry.set(state.connection, AsyncResult.success(connected(2))));
  await pushSettings(2);
  expect(state.persist).toHaveBeenCalledTimes(2);
});

it("waits for the environment to connect before migrating", async () => {
  registry.set(state.connection, AsyncResult.success(AVAILABLE_CONNECTION_STATE));
  await renderModelPicker(EnvironmentId.make("connecting"));
  await pushSettings(2);
  expect(state.persist).not.toHaveBeenCalled();
  await act(async () => registry.set(state.connection, AsyncResult.success(connected(1))));
  await pushSettings(2);
  expect(state.persist).toHaveBeenCalledTimes(1);
});
