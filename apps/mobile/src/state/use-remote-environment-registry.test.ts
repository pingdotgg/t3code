import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import {
  createManagedRelaySession,
  ManagedRelayDpopSigner,
  setManagedRelaySession,
} from "@t3tools/client-runtime";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const environmentConnection = {
    ensureBootstrapped: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(() => Promise.resolve()),
  };
  const sessionConnection = {
    dispose: vi.fn(() => Promise.resolve()),
    reconnect: vi.fn(() => Promise.resolve()),
  };
  const sessionClient = {
    isHeartbeatFresh: vi.fn(() => false),
  };
  return {
    environmentConnection,
    sessionConnection,
    sessionClient,
    createEnvironmentConnection: vi.fn(() => environmentConnection),
    createKnownEnvironment: vi.fn((input: unknown) => input),
    createWsRpcClient: vi.fn(() => ({ rpc: true })),
    wsTransportConstructor: vi.fn(),
    resolveRemoteWebSocketConnectionUrl: vi.fn(() => ({ _tag: "remote-ws-url-effect" })),
    resolveRemoteDpopWebSocketConnectionUrl: vi.fn(),
    remoteEndpointUrl: vi.fn((baseUrl: string, path: string) => new URL(path, baseUrl).toString()),
    createDpopProof: vi.fn(),
    refreshCloudEnvironmentConnection: vi.fn(),
    bootstrapRemoteConnection: vi.fn(),
    clearCachedShellSnapshot: vi.fn(() => Promise.resolve()),
    clearSavedConnection: vi.fn(() => Promise.resolve()),
    saveConnection: vi.fn((_connection?: unknown) => Promise.resolve()),
    saveCachedShellSnapshot: vi.fn(() => Promise.resolve()),
    mobileRunPromise: vi.fn((_effect?: unknown) =>
      Promise.resolve("wss://desktop.example/ws?wsTicket=token"),
    ),
    removeEnvironmentSession: vi.fn(() => null),
    getEnvironmentSession: vi.fn(() => null),
    setEnvironmentSession: vi.fn(),
    notifyEnvironmentConnectionListeners: vi.fn(),
    stopAgentAwarenessForEnvironment: vi.fn(),
    startAgentAwarenessForEnvironment: vi.fn(),
    shellSnapshotInvalidate: vi.fn(),
    shellSnapshotMarkPending: vi.fn(),
    environmentRuntimeInvalidate: vi.fn(),
    environmentRuntimePatch: vi.fn(),
    clearCachedShellSnapshotMetadata: vi.fn(),
    invalidateSourceControlDiscoveryForEnvironment: vi.fn(),
    terminalSessionInvalidateEnvironment: vi.fn(),
    subscribeTerminalMetadata: vi.fn(() => vi.fn()),
    terminalDebugLog: vi.fn(),
    WsTransport: function WsTransport(...args: ReadonlyArray<unknown>) {
      mocks.wsTransportConstructor(...args);
    },
  };
});

vi.mock("react-native", () => ({
  Alert: {
    alert: vi.fn(),
  },
  AppState: {
    currentState: "active",
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

vi.mock("@t3tools/client-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime")>();
  return {
    ...actual,
    WsTransport: mocks.WsTransport,
    createEnvironmentConnection: mocks.createEnvironmentConnection,
    createKnownEnvironment: mocks.createKnownEnvironment,
    createWsRpcClient: mocks.createWsRpcClient,
    remoteEndpointUrl: mocks.remoteEndpointUrl,
    resolveRemoteDpopWebSocketConnectionUrl: mocks.resolveRemoteDpopWebSocketConnectionUrl,
    resolveRemoteWebSocketConnectionUrl: mocks.resolveRemoteWebSocketConnectionUrl,
  };
});

vi.mock("../lib/connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/connection")>()),
  bootstrapRemoteConnection: mocks.bootstrapRemoteConnection,
}));

vi.mock("../features/cloud/linkEnvironment", () => ({
  refreshCloudEnvironmentConnection: mocks.refreshCloudEnvironmentConnection,
}));

vi.mock("../lib/storage", () => ({
  clearCachedShellSnapshot: mocks.clearCachedShellSnapshot,
  clearSavedConnection: mocks.clearSavedConnection,
  loadCachedShellSnapshot: vi.fn(() => Promise.resolve(null)),
  loadSavedConnections: vi.fn(() => Promise.resolve([])),
  saveCachedShellSnapshot: mocks.saveCachedShellSnapshot,
  saveConnection: mocks.saveConnection,
}));

vi.mock("../lib/runtime", () => ({
  mobileRuntime: {
    runPromise: mocks.mobileRunPromise,
  },
}));

vi.mock("./environment-session-registry", () => ({
  drainEnvironmentSessions: vi.fn(() => []),
  getEnvironmentSession: mocks.getEnvironmentSession,
  notifyEnvironmentConnectionListeners: mocks.notifyEnvironmentConnectionListeners,
  removeEnvironmentSession: mocks.removeEnvironmentSession,
  setEnvironmentSession: mocks.setEnvironmentSession,
}));

vi.mock("../features/agent-awareness/shellLiveActivitySync", () => ({
  startAgentAwarenessForEnvironment: mocks.startAgentAwarenessForEnvironment,
  stopAgentAwarenessForEnvironment: mocks.stopAgentAwarenessForEnvironment,
  stopAllAgentAwareness: vi.fn(),
}));

vi.mock("../features/terminal/terminalDebugLog", () => ({
  terminalDebugLog: mocks.terminalDebugLog,
}));

vi.mock("./use-environment-runtime", () => ({
  environmentRuntimeManager: {
    invalidate: mocks.environmentRuntimeInvalidate,
    patch: mocks.environmentRuntimePatch,
  },
  useEnvironmentRuntimeStates: vi.fn(() => ({})),
}));

vi.mock("./use-shell-snapshot", () => ({
  clearCachedShellSnapshotMetadata: mocks.clearCachedShellSnapshotMetadata,
  hydrateCachedShellSnapshot: vi.fn(),
  markShellSnapshotLive: vi.fn(),
  shellSnapshotManager: {
    applyEvent: vi.fn(),
    invalidate: mocks.shellSnapshotInvalidate,
    markPending: mocks.shellSnapshotMarkPending,
    syncSnapshot: vi.fn(),
  },
}));

vi.mock("./use-source-control-discovery", () => ({
  invalidateSourceControlDiscoveryForEnvironment:
    mocks.invalidateSourceControlDiscoveryForEnvironment,
  resetSourceControlDiscoveryState: vi.fn(),
}));

vi.mock("./use-terminal-session", () => ({
  subscribeTerminalMetadata: mocks.subscribeTerminalMetadata,
  terminalSessionManager: {
    invalidate: vi.fn(),
    invalidateEnvironment: mocks.terminalSessionInvalidateEnvironment,
  },
}));

import {
  connectSavedEnvironment,
  disconnectEnvironment,
  reconnectEnvironmentConnectionsAfterAppResume,
} from "./use-remote-environment-registry";
import { appAtomRegistry } from "./atom-registry";

const environmentId = EnvironmentId.make("env-mobile-test");

const connection = {
  environmentId,
  environmentLabel: "Mobile Test Desktop",
  pairingUrl: "https://desktop.example/",
  displayUrl: "https://desktop.example/",
  httpBaseUrl: "https://desktop.example/",
  wsBaseUrl: "wss://desktop.example/",
  bearerToken: "remote-access-token",
} as const;

describe("mobile remote environment registry effects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createEnvironmentConnection.mockReturnValue(mocks.environmentConnection);
    mocks.environmentConnection.ensureBootstrapped.mockResolvedValue(undefined);
    mocks.environmentConnection.dispose.mockResolvedValue(undefined);
    mocks.sessionConnection.dispose.mockResolvedValue(undefined);
    mocks.sessionConnection.reconnect.mockResolvedValue(undefined);
    mocks.sessionClient.isHeartbeatFresh.mockReturnValue(false);
    mocks.removeEnvironmentSession.mockReturnValue(null);
    mocks.getEnvironmentSession.mockReturnValue(null);
    mocks.mobileRunPromise.mockResolvedValue("wss://desktop.example/ws?wsTicket=token");
    mocks.createDpopProof.mockReturnValue(Effect.succeed("dpop-proof"));
    mocks.refreshCloudEnvironmentConnection.mockReturnValue(Effect.die("unexpected refresh"));
    mocks.resolveRemoteDpopWebSocketConnectionUrl.mockReturnValue(
      Effect.succeed("wss://desktop.example/ws?wsTicket=dpop-token"),
    );
    setManagedRelaySession(appAtomRegistry, null);
  });

  it.effect("connects a saved managed endpoint environment through Effect-wrapped APIs", () =>
    Effect.gen(function* () {
      yield* connectSavedEnvironment(connection);

      expect(mocks.saveConnection).toHaveBeenCalledWith(connection);
      expect(mocks.wsTransportConstructor).toHaveBeenCalledTimes(1);
      expect(mocks.createEnvironmentConnection).toHaveBeenCalledTimes(1);
      expect(mocks.setEnvironmentSession).toHaveBeenCalledWith(
        connection.environmentId,
        expect.objectContaining({
          connection: mocks.environmentConnection,
        }),
      );
      expect(mocks.subscribeTerminalMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: connection.environmentId }),
      );
      expect(mocks.startAgentAwarenessForEnvironment).toHaveBeenCalledWith(connection);
      expect(mocks.environmentConnection.ensureBootstrapped).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("uses DPoP-bound admission for a managed DPoP connection", () =>
    Effect.gen(function* () {
      const dpopConnection = {
        ...connection,
        bearerToken: null,
        authenticationMethod: "dpop",
        dpopAccessToken: "environment-dpop-token",
      } as const;
      mocks.mobileRunPromise.mockImplementationOnce((effect?: unknown) =>
        Effect.runPromise(
          (effect as Effect.Effect<string, unknown, ManagedRelayDpopSigner>).pipe(
            Effect.provideService(
              ManagedRelayDpopSigner,
              ManagedRelayDpopSigner.of({
                thumbprint: Effect.succeed("mobile-key-thumbprint"),
                createProof: mocks.createDpopProof,
              }),
            ),
          ),
        ),
      );

      yield* connectSavedEnvironment(dpopConnection);
      const openSocket = mocks.wsTransportConstructor.mock.calls[0]?.[0] as
        | (() => Promise<string>)
        | undefined;
      expect(openSocket).toBeDefined();
      yield* Effect.promise(() => openSocket!());

      expect(mocks.createDpopProof).toHaveBeenCalledWith({
        method: "POST",
        url: "https://desktop.example/api/auth/websocket-ticket",
        accessToken: "environment-dpop-token",
      });
      expect(mocks.resolveRemoteDpopWebSocketConnectionUrl).toHaveBeenCalledWith({
        wsBaseUrl: dpopConnection.wsBaseUrl,
        httpBaseUrl: dpopConnection.httpBaseUrl,
        accessToken: "environment-dpop-token",
        dpopProof: "dpop-proof",
      });
      expect(mocks.resolveRemoteWebSocketConnectionUrl).not.toHaveBeenCalled();
    }),
  );

  it.effect("refreshes a persisted managed connection before reconnecting", () =>
    Effect.gen(function* () {
      const savedDpopConnection = {
        ...connection,
        bearerToken: null,
        authenticationMethod: "dpop",
        relayManaged: true,
      } as const;
      const refreshedConnection = {
        ...savedDpopConnection,
        displayUrl: "https://rotated-desktop.example/",
        httpBaseUrl: "https://rotated-desktop.example/",
        wsBaseUrl: "wss://rotated-desktop.example/",
        dpopAccessToken: "fresh-environment-dpop-token",
      } as const;
      setManagedRelaySession(
        appAtomRegistry,
        createManagedRelaySession({
          accountId: "account-1",
          readClerkToken: () => Promise.resolve("fresh-clerk-token"),
        }),
      );
      mocks.refreshCloudEnvironmentConnection.mockReturnValue(Effect.succeed(refreshedConnection));
      mocks.mobileRunPromise.mockImplementationOnce((effect?: unknown) =>
        Effect.runPromise(
          (effect as Effect.Effect<string, unknown, ManagedRelayDpopSigner>).pipe(
            Effect.provideService(
              ManagedRelayDpopSigner,
              ManagedRelayDpopSigner.of({
                thumbprint: Effect.succeed("mobile-key-thumbprint"),
                createProof: mocks.createDpopProof,
              }),
            ),
          ),
        ),
      );

      yield* connectSavedEnvironment(savedDpopConnection, { persist: false });
      const openSocket = mocks.wsTransportConstructor.mock.calls[0]?.[0] as
        | (() => Promise<string>)
        | undefined;
      expect(openSocket).toBeDefined();
      yield* Effect.promise(() => openSocket!());

      expect(mocks.refreshCloudEnvironmentConnection).toHaveBeenCalledWith({
        clerkToken: "fresh-clerk-token",
        connection: savedDpopConnection,
      });
      const persistedConnection = mocks.saveConnection.mock.calls[0]?.[0];
      expect(persistedConnection).toMatchObject({
        ...savedDpopConnection,
        displayUrl: refreshedConnection.displayUrl,
        httpBaseUrl: refreshedConnection.httpBaseUrl,
        wsBaseUrl: refreshedConnection.wsBaseUrl,
      });
      expect(persistedConnection).not.toHaveProperty("dpopAccessToken");
      expect(mocks.createDpopProof).toHaveBeenCalledWith({
        method: "POST",
        url: "https://rotated-desktop.example/api/auth/websocket-ticket",
        accessToken: "fresh-environment-dpop-token",
      });
      expect(mocks.resolveRemoteDpopWebSocketConnectionUrl).toHaveBeenCalledWith({
        wsBaseUrl: refreshedConnection.wsBaseUrl,
        httpBaseUrl: refreshedConnection.httpBaseUrl,
        accessToken: "fresh-environment-dpop-token",
        dpopProof: "dpop-proof",
      });
    }),
  );

  it.effect("fails interactive connects when the managed endpoint bootstrap fails", () =>
    Effect.gen(function* () {
      mocks.environmentConnection.ensureBootstrapped.mockRejectedValueOnce(
        new Error("bootstrap failed"),
      );
      mocks.removeEnvironmentSession.mockReturnValueOnce(null).mockReturnValueOnce({
        connection: mocks.sessionConnection,
      } as never);

      const result = yield* Effect.exit(connectSavedEnvironment(connection));

      expect(result._tag).toBe("Failure");
      expect(mocks.environmentRuntimePatch).toHaveBeenCalledWith(
        { environmentId: connection.environmentId },
        expect.any(Function),
      );
      expect(mocks.sessionConnection.dispose).toHaveBeenCalledTimes(1);
      expect(mocks.subscribeTerminalMetadata).not.toHaveBeenCalled();
      expect(mocks.startAgentAwarenessForEnvironment).not.toHaveBeenCalled();
    }),
  );

  it.effect("can suppress bootstrap failures during best-effort startup reconnect", () =>
    Effect.gen(function* () {
      mocks.environmentConnection.ensureBootstrapped.mockRejectedValueOnce(
        new Error("bootstrap failed"),
      );
      mocks.removeEnvironmentSession.mockReturnValueOnce(null).mockReturnValueOnce({
        connection: mocks.sessionConnection,
      } as never);

      yield* connectSavedEnvironment(connection, {
        persist: false,
        suppressBootstrapError: true,
      });

      expect(mocks.saveConnection).not.toHaveBeenCalled();
      expect(mocks.environmentConnection.ensureBootstrapped).toHaveBeenCalledTimes(1);
      expect(mocks.sessionConnection.dispose).toHaveBeenCalledTimes(1);
      expect(mocks.subscribeTerminalMetadata).not.toHaveBeenCalled();
      expect(mocks.startAgentAwarenessForEnvironment).not.toHaveBeenCalled();
      expect(mocks.environmentRuntimePatch).toHaveBeenCalledWith(
        { environmentId: connection.environmentId },
        expect.any(Function),
      );
    }),
  );

  it.effect("reconnects a stale saved environment session after app resume", () =>
    Effect.gen(function* () {
      yield* connectSavedEnvironment(connection);
      vi.clearAllMocks();
      mocks.getEnvironmentSession.mockReturnValue({
        client: mocks.sessionClient,
        connection: mocks.sessionConnection,
      } as never);

      reconnectEnvironmentConnectionsAfterAppResume("test");

      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(mocks.sessionConnection.reconnect).toHaveBeenCalledTimes(1);
        }),
      );
      expect(mocks.shellSnapshotMarkPending).toHaveBeenCalledWith({
        environmentId: connection.environmentId,
      });
      expect(mocks.environmentRuntimePatch).toHaveBeenCalledWith(
        { environmentId: connection.environmentId },
        expect.any(Function),
      );
    }),
  );

  it.effect("disconnects and removes persisted managed endpoint state when requested", () =>
    Effect.gen(function* () {
      mocks.removeEnvironmentSession.mockReturnValue({
        connection: mocks.sessionConnection,
      } as never);

      yield* disconnectEnvironment(connection.environmentId, { removeSaved: true });

      expect(mocks.sessionConnection.dispose).toHaveBeenCalledTimes(1);
      expect(mocks.stopAgentAwarenessForEnvironment).toHaveBeenCalledWith(connection.environmentId);
      expect(mocks.clearSavedConnection).toHaveBeenCalledWith(connection.environmentId);
      expect(mocks.clearCachedShellSnapshot).toHaveBeenCalledWith(connection.environmentId);
      expect(mocks.clearCachedShellSnapshotMetadata).toHaveBeenCalledWith(connection.environmentId);
    }),
  );
});
