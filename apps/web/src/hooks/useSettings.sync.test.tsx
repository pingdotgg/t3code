import { RegistryContext } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
const state = vi.hoisted(() => ({
  registry: null as AtomRegistry.AtomRegistry | null,
  sessions: new Map<EnvironmentId, Atom.Writable<SessionResult>>(),
  environments: [] as Array<{
    environmentId: EnvironmentId;
    label: string;
    connection: { phase: "connected" | "disconnected" };
    serverConfig: {
      environment: { capabilities: { threadAutoSettlement: boolean } };
      settings: typeof DEFAULT_SERVER_SETTINGS;
    };
  }>,
  persist: vi.fn(),
}));

vi.mock("~/connection/runtime", () => ({ connectionAtomRuntime: undefined }));
vi.mock("@t3tools/client-runtime/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({
    sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id)!,
  }),
}));
vi.mock("~/rpc/atomRegistry", () => ({
  get appAtomRegistry() {
    return state.registry;
  },
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
  usePrimaryEnvironment: () => state.environments[0],
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { updateSettings: Symbol("updateSettings") },
  primaryServerSettingsAtom: undefined,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.persist }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/themePalette", () => ({}));
vi.mock("./useTheme", () => ({}));

import { useUpdatePrimarySettings } from "./useSettings";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
const patch = { sidebarAutoSettleOnMerge: false } satisfies ServerSettingsPatch;
const session = (scopes: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState => ({
  authenticated: true,
  scopes,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
  },
});
let renderer: ReactTestRenderer | undefined;

function SettingsEditor() {
  const updateSettings = useUpdatePrimarySettings();
  return <button onClick={() => updateSettings(patch)}>Save shared setting</button>;
}

function saveSharedSettings() {
  renderer!.root.findByType("button").props.onClick();
}

async function mountEditor() {
  await act(() => {
    renderer = create(
      <RegistryContext.Provider value={state.registry!}>
        <SettingsEditor />
      </RegistryContext.Provider>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.registry = AtomRegistry.make();
  state.sessions.clear();
  state.sessions.set(
    primaryId,
    Atom.make<SessionResult>(AsyncResult.success(session([AuthSettingsWriteScope]))),
  );
  state.sessions.set(remoteId, Atom.make<SessionResult>(AsyncResult.initial()));
  state.environments = [primaryId, remoteId].map((environmentId) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" },
    serverConfig: {
      environment: { capabilities: { threadAutoSettlement: true } },
      settings: DEFAULT_SERVER_SETTINGS,
    },
  }));
  state.persist.mockReset();
  state.persist.mockResolvedValue(AsyncResult.success(DEFAULT_SERVER_SETTINGS));
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  state.registry?.dispose();
  vi.unstubAllGlobals();
});

describe("shared settings writes", () => {
  it("dispatches to the primary and connected remote before the remote grant finishes loading", async () => {
    await mountEditor();
    saveSharedSettings();

    expect(state.persist.mock.calls).toEqual([
      [{ environmentId: primaryId, input: { patch } }],
      [{ environmentId: remoteId, input: { patch } }],
    ]);
    expect(state.registry!.get(state.sessions.get(remoteId)!)).toMatchObject({ _tag: "Initial" });
  });

  it.each([
    ["denied", () => AsyncResult.success(session([]))],
    ["denied while refreshing", () => AsyncResult.waiting(AsyncResult.success(session([])))],
    ["failed", () => AsyncResult.failure(Cause.fail(new Error("session rejected")))],
  ] as const)("skips a remote whose grant is %s", async (_label, result) => {
    state.registry!.set(state.sessions.get(remoteId)!, result());
    await mountEditor();
    saveSharedSettings();

    expect(state.persist).toHaveBeenCalledExactlyOnceWith({
      environmentId: primaryId,
      input: { patch },
    });
  });

  it.each(["disconnected", "unsupported"] as const)(
    "skips a %s remote even with a cold grant",
    async (condition) => {
      const remote = state.environments[1]!;
      if (condition === "disconnected") remote.connection.phase = "disconnected";
      else remote.serverConfig.environment.capabilities.threadAutoSettlement = false;
      await mountEditor();
      saveSharedSettings();

      expect(state.persist).toHaveBeenCalledExactlyOnceWith({
        environmentId: primaryId,
        input: { patch },
      });
    },
  );

  it("rechecks a cold remote grant that resolves to denied after the handler renders", async () => {
    await mountEditor();
    const previousUpdate = renderer!.root.findByType("button").props.onClick as () => void;
    await act(() => {
      state.registry!.set(state.sessions.get(remoteId)!, AsyncResult.success(session([])));
    });
    previousUpdate();

    expect(state.persist).toHaveBeenCalledExactlyOnceWith({
      environmentId: primaryId,
      input: { patch },
    });
  });
});
