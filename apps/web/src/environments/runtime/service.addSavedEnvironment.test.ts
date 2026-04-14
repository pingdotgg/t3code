import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveRemotePairingTarget = vi.fn();
const mockFetchRemoteEnvironmentDescriptor = vi.fn();
const mockBootstrapRemoteBearerSession = vi.fn();
const mockBootstrapSshBearerSession = vi.fn();
const mockPersistSavedEnvironmentRecord = vi.fn();
const mockWriteSavedEnvironmentBearerToken = vi.fn();
const mockSetSavedEnvironmentRegistry = vi.fn();
const mockUpsert = vi.fn();
const mockListSavedEnvironmentRecords = vi.fn();
const mockEnsureSshEnvironment = vi.fn();
const mockFetchSshEnvironmentDescriptor = vi.fn();
const mockCreateEnvironmentConnection = vi.fn();

vi.mock("../remote/target", () => ({
  resolveRemotePairingTarget: mockResolveRemotePairingTarget,
}));

vi.mock("../remote/api", () => ({
  bootstrapRemoteBearerSession: mockBootstrapRemoteBearerSession,
  fetchRemoteEnvironmentDescriptor: mockFetchRemoteEnvironmentDescriptor,
  fetchRemoteSessionState: vi.fn(),
  isRemoteEnvironmentAuthHttpError: vi.fn(() => false),
  resolveRemoteWebSocketConnectionUrl: vi.fn(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      setSavedEnvironmentRegistry: mockSetSavedEnvironmentRegistry,
    },
  }),
}));

vi.mock("./catalog", () => ({
  getSavedEnvironmentRecord: vi.fn(),
  hasSavedEnvironmentRegistryHydrated: vi.fn(),
  listSavedEnvironmentRecords: mockListSavedEnvironmentRecords,
  persistSavedEnvironmentRecord: mockPersistSavedEnvironmentRecord,
  readSavedEnvironmentBearerToken: vi.fn(),
  removeSavedEnvironmentBearerToken: vi.fn(),
  useSavedEnvironmentRegistryStore: {
    getState: () => ({
      upsert: mockUpsert,
      remove: vi.fn(),
      markConnected: vi.fn(),
    }),
  },
  useSavedEnvironmentRuntimeStore: {
    getState: () => ({
      ensure: vi.fn(),
      patch: vi.fn(),
      clear: vi.fn(),
    }),
  },
  waitForSavedEnvironmentRegistryHydration: vi.fn(),
  writeSavedEnvironmentBearerToken: mockWriteSavedEnvironmentBearerToken,
}));

vi.mock("./connection", () => ({
  createEnvironmentConnection: mockCreateEnvironmentConnection,
}));

describe("addSavedEnvironment", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      desktopBridge: {
        ensureSshEnvironment: mockEnsureSshEnvironment,
        fetchSshEnvironmentDescriptor: mockFetchSshEnvironmentDescriptor,
        bootstrapSshBearerSession: mockBootstrapSshBearerSession,
        fetchSshSessionState: vi.fn(),
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
    mockListSavedEnvironmentRecords.mockReturnValue([]);
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
    ).rejects.toThrow();

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
