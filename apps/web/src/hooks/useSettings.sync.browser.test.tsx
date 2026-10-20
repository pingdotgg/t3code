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
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
const state = vi.hoisted(() => ({
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
  toast: vi.fn(),
}));

vi.mock(import("@t3tools/client-runtime/state/session"), async (original) => ({
  ...(await original()),
  createEnvironmentSessionAtoms: (() => ({
    sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id)!,
  })) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: state.environments })) as never,
  usePrimaryEnvironment: (() =>
    state.environments.find((environment) => environment.environmentId === primaryId) ??
    null) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.persist) as never,
}));
vi.mock(import("~/components/ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});

import { appAtomRegistry } from "~/rpc/atomRegistry";
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
function SettingsEditor({ handlers }: { handlers: Array<() => void> }) {
  const updateSettings = useUpdatePrimarySettings();
  const save = () => void updateSettings(patch);
  handlers.push(save);
  return <button onClick={save}>Save shared setting</button>;
}

async function mountEditor() {
  const handlers: Array<() => void> = [];
  const screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <SettingsEditor handlers={handlers} />
    </RegistryContext.Provider>,
  );
  return {
    handlers,
    saveSharedSettings: () => screen.container.querySelector("button")!.click(),
    [Symbol.asyncDispose]: () => screen[Symbol.asyncDispose](),
  };
}

function setup() {
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
  state.toast.mockReset();
}

describe("shared settings writes", () => {
  it("waits for the remaining target before reporting a partial save", async () => {
    setup();
    let finishRemote = () => {};
    const remote = new Promise((resolve) => {
      finishRemote = () => resolve(AsyncResult.success(DEFAULT_SERVER_SETTINGS));
    });
    state.persist.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Permission denied"))),
    );
    state.persist.mockReturnValueOnce(remote);
    await using editor = await mountEditor();
    await act(async () => editor.saveSharedSettings());
    expect(state.toast).not.toHaveBeenCalled();
    await act(async () => finishRemote());
    expect(state.toast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Setting saved on some environments",
      description: "Could not save on primary: Permission denied\nSaved on remote.",
    });
  });

  it("keeps a single-target failure specific to that environment", async () => {
    setup();
    appAtomRegistry.set(state.sessions.get(remoteId)!, AsyncResult.success(session([])));
    state.persist.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Permission denied"))),
    );
    await using editor = await mountEditor();
    await act(async () => editor.saveSharedSettings());
    expect(state.toast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Setting not saved",
      description: "Could not save on primary: Permission denied",
    });
  });

  it("names the failed environment when a server rejects a save after the grant check", async () => {
    setup();
    state.persist.mockResolvedValueOnce(AsyncResult.success(DEFAULT_SERVER_SETTINGS));
    state.persist.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Permission denied"))),
    );
    await using editor = await mountEditor();
    await act(async () => editor.saveSharedSettings());
    expect(state.toast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Setting saved on some environments",
      description: "Could not save on remote: Permission denied\nSaved on primary.",
    });
  });

  it("dispatches to the primary and connected remote before the remote grant finishes loading", async () => {
    setup();
    await using editor = await mountEditor();
    editor.saveSharedSettings();

    expect(state.persist.mock.calls).toEqual([
      [{ environmentId: primaryId, input: { patch } }],
      [{ environmentId: remoteId, input: { patch } }],
    ]);
    expect(appAtomRegistry.get(state.sessions.get(remoteId)!)).toMatchObject({ _tag: "Initial" });
  });

  it.each([
    ["denied", () => AsyncResult.success(session([]))],
    ["denied while refreshing", () => AsyncResult.waiting(AsyncResult.success(session([])))],
    [
      "failed",
      () => AsyncResult.failure<AuthSessionState, Error>(Cause.fail(new Error("session rejected"))),
    ],
  ] as const)("skips a remote whose grant is %s", async (_label, result) => {
    setup();
    appAtomRegistry.set(state.sessions.get(remoteId)!, result());
    await using editor = await mountEditor();
    editor.saveSharedSettings();

    expect(state.persist).toHaveBeenCalledExactlyOnceWith({
      environmentId: primaryId,
      input: { patch },
    });
  });

  it.each(["disconnected", "unsupported"] as const)(
    "skips a %s remote even with a cold grant",
    async (condition) => {
      setup();
      const remote = state.environments[1]!;
      if (condition === "disconnected") remote.connection.phase = "disconnected";
      else remote.serverConfig.environment.capabilities.threadAutoSettlement = false;
      await using editor = await mountEditor();
      editor.saveSharedSettings();

      expect(state.persist).toHaveBeenCalledExactlyOnceWith({
        environmentId: primaryId,
        input: { patch },
      });
    },
  );

  it.each(["primary", "hosted"] as const)(
    "rechecks a cold remote grant that resolves to denied after the %s handler renders",
    async (mode) => {
      setup();
      if (mode === "hosted") {
        state.environments = state.environments.filter(
          (environment) => environment.environmentId !== primaryId,
        );
      }
      await using editor = await mountEditor();
      const previousUpdate = editor.handlers.at(-1)!;
      await act(() => {
        appAtomRegistry.set(state.sessions.get(remoteId)!, AsyncResult.success(session([])));
      });
      previousUpdate();

      if (mode === "primary") {
        expect(state.persist).toHaveBeenCalledExactlyOnceWith({
          environmentId: primaryId,
          input: { patch },
        });
        expect(state.toast).not.toHaveBeenCalled();
      } else {
        expect(state.persist).not.toHaveBeenCalled();
        expect(state.toast).toHaveBeenCalledExactlyOnceWith({
          type: "warning",
          title: "Setting not saved",
          description: "This connection lacks permission to change settings on remote.",
        });
      }
    },
  );
});
