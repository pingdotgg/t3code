import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockSavedRecords: Array<Record<string, unknown>> = [];

const mockResolveRemotePairingTarget = vi.fn();
const mockFetchRemoteEnvironmentDescriptor = vi.fn();
const mockBootstrapRemoteBearerSession = vi.fn();
const mockFetchRemoteSessionState = vi.fn();
const mockIsRemoteEnvironmentAuthHttpError = vi.fn((_: unknown) => false);
const mockResolveRemoteWebSocketConnectionUrl = vi.fn();
const mockBootstrapSshBearerSession = vi.fn();
const mockFetchSshSessionState = vi.fn();
const mockPersistSavedEnvironmentRecord = vi.fn();
const mockWriteSavedEnvironmentBearerToken = vi.fn();
const mockSetSavedEnvironmentRegistry = vi.fn();
const mockGetSavedEnvironmentRecord = vi.fn((environmentId: EnvironmentId) => {
  return mockSavedRecords.find((record) => record.environmentId === environmentId) ?? null;
});
const mockReadSavedEnvironmentBearerToken = vi.fn();
const mockRemoveSavedEnvironmentBearerToken = vi.fn();
const mockPatchRuntime = vi.fn();
const mockClearRuntime = vi.fn();
const mockRegistrySetState = vi.fn((next: { byId: Record<string, Record<string, unknown>> }) => {
  mockSavedRecords = Object.values(next.byId);
});
const mockRemove = vi.fn((environmentId: EnvironmentId) => {
  mockSavedRecords = mockSavedRecords.filter((record) => record.environmentId !== environmentId);
});
const mockMarkConnected = vi.fn((environmentId: EnvironmentId, connectedAt: string) => {
  mockSavedRecords = mockSavedRecords.map((record) =>
    record.environmentId === environmentId ? { ...record, lastConnectedAt: connectedAt } : record,
  );
});
const mockUpsert = vi.fn((record: Record<string, unknown>) => {
  mockSavedRecords = [
    ...mockSavedRecords.filter((entry) => entry.environmentId !== record.environmentId),
    record,
  ];
});
const mockListSavedEnvironmentRecords = vi.fn(() => mockSavedRecords);
const mockEnsureSshEnvironment = vi.fn();
const mockFetchSshEnvironmentDescriptor = vi.fn();
const mockToPersistedSavedEnvironmentRecord = vi.fn((record) => record);
const mockCreateEnvironmentConnection = vi.fn();
const mockClientGetConfig = vi.fn(async () => ({
  environment: {
    environmentId: EnvironmentId.make("environment-1"),
    label: "Remote environment",
  },
}));

vi.mock("../remote/target", () => ({
  resolveRemotePairingTarget: mockResolveRemotePairingTarget,
}));

vi.mock("../remote/api", () => ({
  bootstrapRemoteBearerSession: mockBootstrapRemoteBearerSession,
  fetchRemoteEnvironmentDescriptor: mockFetchRemoteEnvironmentDescriptor,
  fetchRemoteSessionState: mockFetchRemoteSessionState,
  isRemoteEnvironmentAuthHttpError: mockIsRemoteEnvironmentAuthHttpError,
  resolveRemoteWebSocketConnectionUrl: mockResolveRemoteWebSocketConnectionUrl,
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      setSavedEnvironmentRegistry: mockSetSavedEnvironmentRegistry,
    },
  }),
}));

vi.mock("./catalog", () => ({
  getSavedEnvironmentRecord: mockGetSavedEnvironmentRecord,
  hasSavedEnvironmentRegistryHydrated: vi.fn(),
  listSavedEnvironmentRecords: mockListSavedEnvironmentRecords,
  persistSavedEnvironmentRecord: mockPersistSavedEnvironmentRecord,
  readSavedEnvironmentBearerToken: mockReadSavedEnvironmentBearerToken,
  removeSavedEnvironmentBearerToken: mockRemoveSavedEnvironmentBearerToken,
  toPersistedSavedEnvironmentRecord: mockToPersistedSavedEnvironmentRecord,
  useSavedEnvironmentRegistryStore: {
    getState: () => ({
      upsert: mockUpsert,
      remove: mockRemove,
      markConnected: mockMarkConnected,
    }),
    setState: mockRegistrySetState,
    subscribe: vi.fn(() => () => {}),
  },
  useSavedEnvironmentRuntimeStore: {
    getState: () => ({
      ensure: vi.fn(),
      patch: mockPatchRuntime,
      clear: mockClearRuntime,
    }),
  },
  waitForSavedEnvironmentRegistryHydration: vi.fn(),
  writeSavedEnvironmentBearerToken: mockWriteSavedEnvironmentBearerToken,
}));

vi.mock("./connection", () => ({
  createEnvironmentConnection: mockCreateEnvironmentConnection,
}));

vi.mock("../../rpc/wsRpcClient", () => ({
  createWsRpcClient: vi.fn(() => ({
    server: {
      getConfig: mockClientGetConfig,
    },
    orchestration: {
      subscribeThread: vi.fn(() => () => {}),
    },
  })),
}));

vi.mock("../../rpc/wsTransport", () => ({
  WsTransport: vi.fn(),
}));

describe("addSavedEnvironment", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSavedRecords = [];
    vi.stubGlobal("window", {
      desktopBridge: {
        ensureSshEnvironment: mockEnsureSshEnvironment,
        fetchSshEnvironmentDescriptor: mockFetchSshEnvironmentDescriptor,
        bootstrapSshBearerSession: mockBootstrapSshBearerSession,
        fetchSshSessionState: mockFetchSshSessionState,
        issueSshWebSocketToken: vi.fn(),
      },
    });
    mockResolveRemotePairingTarget.mockImplementation(
      (input: { host?: string; pairingCode?: string }) => ({
        httpBaseUrl: input.host
          ? input.host.endsWith("/")
            ? input.host
            : `${input.host}/`
          : "https://remote.example.com/",
        wsBaseUrl: input.host
          ? input.host.replace(/^http/u, "ws").endsWith("/")
            ? input.host.replace(/^http/u, "ws")
            : `${input.host.replace(/^http/u, "ws")}/`
          : "wss://remote.example.com/",
        credential: input.pairingCode ?? "pairing-code",
      }),
    );
    mockFetchRemoteEnvironmentDescriptor.mockResolvedValue({
      environmentId: EnvironmentId.make("environment-1"),
      label: "Remote environment",
    });
    mockBootstrapRemoteBearerSession.mockResolvedValue({
      sessionToken: "bearer-token",
      role: "owner",
    });
    mockFetchRemoteSessionState.mockResolvedValue({
      authenticated: true,
      role: "owner",
    });
    mockIsRemoteEnvironmentAuthHttpError.mockReturnValue(false);
    mockResolveRemoteWebSocketConnectionUrl.mockResolvedValue(
      "wss://remote.example.com/?wsToken=remote-token",
    );
    mockFetchSshEnvironmentDescriptor.mockResolvedValue({
      environmentId: EnvironmentId.make("environment-1"),
      label: "Remote environment",
    });
    mockBootstrapSshBearerSession.mockResolvedValue({
      sessionToken: "ssh-bearer-token",
      role: "owner",
    });
    mockPersistSavedEnvironmentRecord.mockResolvedValue(undefined);
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(false);
    mockSetSavedEnvironmentRegistry.mockResolvedValue(undefined);
    mockReadSavedEnvironmentBearerToken.mockResolvedValue(null);
    mockRemoveSavedEnvironmentBearerToken.mockResolvedValue(undefined);
    mockFetchSshSessionState.mockResolvedValue({
      authenticated: true,
      role: "owner",
    });
    mockCreateEnvironmentConnection.mockImplementation(
      (input: { knownEnvironment: { environmentId: EnvironmentId }; client: unknown }) => ({
        kind: "saved",
        environmentId: input.knownEnvironment.environmentId,
        knownEnvironment: input.knownEnvironment,
        client: input.client,
        ensureBootstrapped: async () => undefined,
        reconnect: async () => undefined,
        dispose: async () => undefined,
      }),
    );
    mockClientGetConfig.mockResolvedValue({
      environment: {
        environmentId: EnvironmentId.make("environment-1"),
        label: "Remote environment",
      },
    });
    mockEnsureSshEnvironment.mockResolvedValue({
      target: {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 22,
      },
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
      pairingToken: "ssh-pairing-code",
    });
  });

  it("rolls back persisted metadata when bearer token persistence fails", async () => {
    const { addSavedEnvironment, resetEnvironmentServiceForTests } = await import("./service");

    await expect(
      addSavedEnvironment({
        label: "Remote environment",
        host: "remote.example.com",
        pairingCode: "123456",
      }),
    ).rejects.toThrow("Unable to persist saved environment credentials.");

    expect(mockPersistSavedEnvironmentRecord).toHaveBeenCalledTimes(1);
    expect(mockWriteSavedEnvironmentBearerToken).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
      "bearer-token",
    );
    expect(mockSetSavedEnvironmentRegistry).toHaveBeenCalledWith([]);
    expect(mockUpsert).not.toHaveBeenCalled();

    await resetEnvironmentServiceForTests();
  });

  it("restores unrelated saved environments when credential persistence rollback runs", async () => {
    mockSavedRecords = [
      {
        environmentId: EnvironmentId.make("environment-existing"),
        label: "Existing environment",
        httpBaseUrl: "https://existing.example.com/",
        wsBaseUrl: "wss://existing.example.com/",
        createdAt: "2026-04-14T00:00:00.000Z",
        lastConnectedAt: null,
      },
    ];

    const { addSavedEnvironment, resetEnvironmentServiceForTests } = await import("./service");

    await expect(
      addSavedEnvironment({
        label: "Remote environment",
        host: "remote.example.com",
        pairingCode: "123456",
      }),
    ).rejects.toThrow("Unable to persist saved environment credentials.");

    expect(mockSetSavedEnvironmentRegistry).toHaveBeenCalledWith([
      expect.objectContaining({
        environmentId: EnvironmentId.make("environment-existing"),
      }),
    ]);

    await resetEnvironmentServiceForTests();
  });

  it("removes an older ssh record when the same target returns a new environment id", async () => {
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);
    mockFetchSshEnvironmentDescriptor.mockResolvedValue({
      environmentId: EnvironmentId.make("environment-2"),
      label: "Remote environment",
    });
    mockSavedRecords = [
      {
        environmentId: EnvironmentId.make("environment-1"),
        label: "Old ssh environment",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
        createdAt: "2026-04-14T00:00:00.000Z",
        lastConnectedAt: null,
        desktopSsh: {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 22,
        },
      },
    ];

    const { addSavedEnvironment, resetEnvironmentServiceForTests } = await import("./service");

    await expect(
      addSavedEnvironment({
        label: "Remote environment",
        host: "http://127.0.0.1:3774/",
        pairingCode: "ssh-pairing-code",
        desktopSsh: {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 22,
        },
      }),
    ).resolves.toMatchObject({
      environmentId: EnvironmentId.make("environment-2"),
    });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: EnvironmentId.make("environment-2"),
      }),
    );
    expect(mockRemove).toHaveBeenCalledWith(EnvironmentId.make("environment-1"));
    expect(mockRemoveSavedEnvironmentBearerToken).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
    );

    await resetEnvironmentServiceForTests();
  });

  it("retries desktop ssh session refresh when the forwarded endpoint returns ssh_http 401", async () => {
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);
    mockBootstrapSshBearerSession
      .mockResolvedValueOnce({
        sessionToken: "ssh-bearer-token",
        role: "owner",
      })
      .mockResolvedValueOnce({
        sessionToken: "ssh-bearer-token-2",
        role: "owner",
      });
    mockFetchSshSessionState
      .mockRejectedValueOnce(new Error("[ssh_http:401] Unauthorized"))
      .mockResolvedValueOnce({
        authenticated: true,
        role: "owner",
      });

    const { connectDesktopSshEnvironment, resetEnvironmentServiceForTests } =
      await import("./service");

    await expect(
      connectDesktopSshEnvironment({
        alias: "devbox",
        hostname: "devbox",
        username: null,
        port: null,
      }),
    ).resolves.toMatchObject({
      environmentId: EnvironmentId.make("environment-1"),
    });

    expect(mockEnsureSshEnvironment).toHaveBeenCalled();
    expect(mockBootstrapSshBearerSession).toHaveBeenCalledTimes(2);
    expect(mockFetchSshSessionState).toHaveBeenCalledTimes(2);

    await resetEnvironmentServiceForTests();
  });

  it("does not attempt desktop ssh bearer recovery for non-ssh saved environments", async () => {
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);
    const authError = {
      status: 401,
      message: "Unauthorized",
    };
    mockFetchRemoteSessionState.mockRejectedValueOnce(authError);
    mockIsRemoteEnvironmentAuthHttpError.mockImplementation(
      (error: unknown) => error === authError,
    );

    const { addSavedEnvironment, resetEnvironmentServiceForTests } = await import("./service");

    await expect(
      addSavedEnvironment({
        label: "Remote environment",
        host: "remote.example.com",
        pairingCode: "123456",
      }),
    ).rejects.toThrow("Saved environment credential expired. Pair it again.");

    expect(mockEnsureSshEnvironment).not.toHaveBeenCalled();
    expect(mockBootstrapSshBearerSession).not.toHaveBeenCalled();
    expect(mockRemoveSavedEnvironmentBearerToken).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
    );

    await resetEnvironmentServiceForTests();
  });

  it("only registers the retried ssh connection after bearer re-issuance succeeds", async () => {
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);
    mockBootstrapSshBearerSession
      .mockResolvedValueOnce({
        sessionToken: "ssh-bearer-token",
        role: "owner",
      })
      .mockResolvedValueOnce({
        sessionToken: "ssh-bearer-token-2",
        role: "owner",
      });
    mockFetchSshSessionState
      .mockRejectedValueOnce(new Error("[ssh_http:401] Unauthorized"))
      .mockResolvedValueOnce({
        authenticated: true,
        role: "owner",
      });

    const createdConnections: Array<{
      readonly environmentId: EnvironmentId;
      readonly dispose: ReturnType<typeof vi.fn>;
    }> = [];
    mockCreateEnvironmentConnection.mockImplementation(
      (input: { knownEnvironment: { environmentId: EnvironmentId }; client: unknown }) => {
        const connection = {
          kind: "saved" as const,
          environmentId: input.knownEnvironment.environmentId,
          knownEnvironment: input.knownEnvironment,
          client: input.client,
          ensureBootstrapped: async () => undefined,
          reconnect: async () => undefined,
          dispose: vi.fn(async () => undefined),
        };
        createdConnections.push(connection);
        return connection;
      },
    );

    const {
      connectDesktopSshEnvironment,
      listEnvironmentConnections,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    await connectDesktopSshEnvironment({
      alias: "devbox",
      hostname: "devbox",
      username: null,
      port: null,
    });

    expect(createdConnections).toHaveLength(2);
    expect(createdConnections[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(listEnvironmentConnections()).toHaveLength(1);
    expect(listEnvironmentConnections()[0]).toBe(createdConnections[1]);

    await resetEnvironmentServiceForTests();
  });

  it("marks desktop ssh reconnect failures as runtime errors when bearer recovery fails", async () => {
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);

    const connection = {
      kind: "saved" as const,
      environmentId: EnvironmentId.make("environment-1"),
      knownEnvironment: {
        environmentId: EnvironmentId.make("environment-1"),
      },
      client: {},
      ensureBootstrapped: async () => undefined,
      reconnect: vi.fn(async () => {
        throw new Error("socket closed");
      }),
      dispose: async () => undefined,
    };
    mockCreateEnvironmentConnection.mockReturnValue(connection);

    const { addSavedEnvironment, reconnectSavedEnvironment, resetEnvironmentServiceForTests } =
      await import("./service");

    await addSavedEnvironment({
      label: "Remote environment",
      host: "http://127.0.0.1:3774/",
      pairingCode: "ssh-pairing-code",
      desktopSsh: {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 22,
      },
    });

    mockSavedRecords = [
      {
        environmentId: EnvironmentId.make("environment-1"),
        label: "Remote environment",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
        createdAt: "2026-04-14T00:00:00.000Z",
        lastConnectedAt: null,
        desktopSsh: {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 22,
        },
      },
    ];
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(false);

    await expect(reconnectSavedEnvironment(EnvironmentId.make("environment-1"))).rejects.toThrow(
      "Unable to persist saved environment credentials.",
    );

    expect(mockPatchRuntime).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
      expect.objectContaining({
        connectionState: "error",
        lastError: "Unable to persist saved environment credentials.",
      }),
    );

    await resetEnvironmentServiceForTests();
  });

  it("bootstraps a desktop ssh environment through the desktop bridge", async () => {
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);

    const { connectDesktopSshEnvironment, resetEnvironmentServiceForTests } =
      await import("./service");

    await expect(
      connectDesktopSshEnvironment({
        alias: "devbox",
        hostname: "devbox",
        username: null,
        port: null,
      }),
    ).resolves.toMatchObject({
      environmentId: EnvironmentId.make("environment-1"),
    });

    expect(mockEnsureSshEnvironment).toHaveBeenCalledWith(
      {
        alias: "devbox",
        hostname: "devbox",
        username: null,
        port: null,
      },
      { issuePairingToken: true },
    );
    expect(mockResolveRemotePairingTarget).toHaveBeenCalledWith({
      host: "http://127.0.0.1:3774/",
      pairingCode: "ssh-pairing-code",
    });
    expect(mockFetchSshEnvironmentDescriptor).toHaveBeenCalledWith("http://127.0.0.1:3774/");
    expect(mockBootstrapSshBearerSession).toHaveBeenCalledWith(
      "http://127.0.0.1:3774/",
      "ssh-pairing-code",
    );
    expect(mockFetchRemoteEnvironmentDescriptor).not.toHaveBeenCalled();
    expect(mockBootstrapRemoteBearerSession).not.toHaveBeenCalled();
    expect(mockUpsert.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateEnvironmentConnection.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    await resetEnvironmentServiceForTests();
  });
});
