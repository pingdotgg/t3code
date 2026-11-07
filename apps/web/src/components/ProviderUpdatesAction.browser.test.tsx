import { RegistryContext } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  type AuthSessionState,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const state = vi.hoisted(() => ({
  environments: [] as {
    environmentId: EnvironmentId;
    label: string;
    connection: { phase: "connected" | "disconnected" };
  }[],
  providers: new Map<EnvironmentId, ReadonlyArray<ServerProvider>>(),
  requests: [] as EnvironmentId[],
  checks: [] as { environmentId: EnvironmentId; input: unknown }[],
  checkResult: null as AsyncResult.AsyncResult<unknown, unknown> | null,
  sessions: new Map<EnvironmentId, Atom.Writable<AsyncResult.AsyncResult<AuthSessionState>>>(),
}));

vi.mock(import("~/state/environments"), () => ({
  useEnvironments: (() => ({ environments: state.environments })) as never,
  useEnvironmentProviders: () => state.providers,
}));
vi.mock(import("@t3tools/client-runtime/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createEnvironmentSessionAtoms: ((
      ...args: Parameters<typeof actual.createEnvironmentSessionAtoms>
    ) => ({
      ...actual.createEnvironmentSessionAtoms(...args),
      sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id)!,
    })) as typeof actual.createEnvironmentSessionAtoms,
  };
});
vi.mock(import("~/state/server"), () => ({
  serverEnvironment: { updateProvider: "update", refreshProviders: "refresh" } as never,
}));
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: ((command: string) =>
    async ({ environmentId, input }: { environmentId: EnvironmentId; input: unknown }) => {
      if (command !== "refresh") {
        state.requests.push(environmentId);
        return AsyncResult.success(undefined);
      }
      state.checks.push({ environmentId, input });
      return state.checkResult ?? AsyncResult.success(undefined);
    }) as never,
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { toastManager } from "./ui/toast";
import { useCheckProviderUpdates, useProviderUpdates } from "./ProviderUpdatesAction";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-21T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    updateCommand: "npm install -g @openai/codex",
    canUpdate: true,
    checkedAt: "2026-10-21T00:00:00.000Z",
    message: "Update available.",
  },
};

function session(
  scopes: NonNullable<AuthSessionState["scopes"]>,
): AsyncResult.AsyncResult<AuthSessionState> {
  return AsyncResult.success<AuthSessionState>({
    authenticated: true,
    scopes,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "t3_session",
    },
  });
}

function setup() {
  state.environments = [
    { environmentId: EnvironmentId.make("read-only"), label: "Read only" },
    { environmentId: EnvironmentId.make("writable"), label: "Writable" },
    { environmentId: EnvironmentId.make("unresolved"), label: "Unresolved" },
  ].map((environment) => ({ ...environment, connection: { phase: "connected" } }));
  state.providers = new Map(
    state.environments.map(({ environmentId }) => [environmentId, [provider]]),
  );
  state.requests = [];
  state.checks = [];
  state.checkResult = null;
  const sessions = new Map<EnvironmentId, Atom.Writable<AsyncResult.AsyncResult<AuthSessionState>>>(
    [
      [state.environments[0]!.environmentId, Atom.make(session(["orchestration:read"]))],
      [state.environments[1]!.environmentId, Atom.make(session([AuthProvidersManageScope]))],
      [
        state.environments[2]!.environmentId,
        Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(
          AsyncResult.initial<AuthSessionState>(),
        ),
      ],
    ],
  );
  state.sessions = sessions;
  return { sessions };
}

it("provider updates and checks exclude connections without a confirmed management grant", async () => {
  const fixture = setup();
  let updates!: ReturnType<typeof useProviderUpdates>;
  let check!: ReturnType<typeof useCheckProviderUpdates>;
  function Probe() {
    const nextUpdates = useProviderUpdates();
    const nextCheck = useCheckProviderUpdates();
    useEffect(() => {
      updates = nextUpdates;
      check = nextCheck;
    }, [nextUpdates, nextCheck]);
    return null;
  }
  await using _screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <Probe />
    </RegistryContext.Provider>,
  );

  const writableId = state.environments[1]!.environmentId;
  expect(updates.machines.map(({ environmentId }) => environmentId)).toEqual([writableId]);
  await act(async () => {
    await updates.updateAll({ quiet: true });
  });
  expect(state.requests).toEqual([writableId]);
  await act(async () => {
    await check();
  });
  // Only a model refresh drops the server's cached latest provider versions.
  expect(state.checks).toEqual([{ environmentId: writableId, input: { refreshModels: true } }]);

  using toast = vi.spyOn(toastManager, "add");
  state.checkResult = AsyncResult.failure(Cause.interrupt());
  await act(async () => {
    await check();
  });
  expect(toast).not.toHaveBeenCalled();
  state.checkResult = AsyncResult.failure(Cause.fail(new Error("offline")));
  await act(async () => {
    await check();
  });
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Could not check provider updates" }),
  );

  await act(() => {
    appAtomRegistry.set(fixture.sessions.get(writableId)!, session(["orchestration:read"]));
  });
  expect(updates.machines).toEqual([]);
  state.requests = [];
  await act(async () => {
    await updates.updateAll({ quiet: true });
  });
  expect(state.requests).toEqual([]);
});
