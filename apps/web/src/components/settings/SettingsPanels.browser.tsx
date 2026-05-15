import "../../index.css";

import {
  type AuthAccessStreamEvent,
  type AuthAccessSnapshot,
  AuthSessionId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type DesktopBridge,
  type DesktopUpdateChannel,
  type DesktopUpdateState,
  type LocalApi,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProcessResourceHistoryResult,
  type ServerProvider,
  type SourceControlDiscoveryResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { ReactNode } from "react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { __resetLocalApiForTests } from "../../localApi";
import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { useUiStateStore } from "../../uiStateStore";
import { ConnectionsSettings } from "./ConnectionsSettings";
import { DiagnosticsSettingsPanel } from "./DiagnosticsSettings";
import { GeneralSettingsPanel, ProviderSettingsPanel } from "./SettingsPanels";
import { SourceControlSettingsPanel } from "./SourceControlSettings";

function renderWithTestRouter(children: ReactNode) {
  const rootRoute = createRootRoute({
    component: () => children,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return render(<RouterProvider router={router} />);
}

const authAccessHarness = vi.hoisted(() => {
  type Snapshot = AuthAccessSnapshot;
  let snapshot: Snapshot = {
    pairingLinks: [],
    clientSessions: [],
  };
  let revision = 1;
  const listeners = new Set<(event: AuthAccessStreamEvent) => void>();

  const emitEvent = (event: AuthAccessStreamEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  return {
    reset() {
      snapshot = {
        pairingLinks: [],
        clientSessions: [],
      };
      revision = 1;
      listeners.clear();
    },
    setSnapshot(next: Snapshot) {
      snapshot = next;
    },
    emitSnapshot() {
      emitEvent({
        version: 1 as const,
        revision,
        type: "snapshot" as const,
        payload: snapshot,
      });
      revision += 1;
    },
    emitEvent,
    emitPairingLinkUpserted(pairingLink: Snapshot["pairingLinks"][number]) {
      emitEvent({
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: pairingLink,
      });
      revision += 1;
    },
    emitPairingLinkRemoved(id: string) {
      emitEvent({
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id },
      });
      revision += 1;
    },
    emitClientUpserted(clientSession: Snapshot["clientSessions"][number]) {
      emitEvent({
        version: 1,
        revision,
        type: "clientUpserted",
        payload: clientSession,
      });
      revision += 1;
    },
    emitClientRemoved(sessionId: string) {
      emitEvent({
        version: 1,
        revision,
        type: "clientRemoved",
        payload: {
          sessionId: AuthSessionId.make(sessionId),
        },
      });
      revision += 1;
    },
    subscribe(listener: (event: AuthAccessStreamEvent) => void) {
      listeners.add(listener);
      listener({
        version: 1,
        revision: 1,
        type: "snapshot",
        payload: snapshot,
      });
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

const mockConnectDesktopSshEnvironment = vi.hoisted(() => vi.fn());

vi.mock("../../environments/runtime", () => {
  const primaryConnection = {
    kind: "primary" as const,
    knownEnvironment: {
      id: "environment-local",
      label: "Local environment",
      source: "manual" as const,
      environmentId: EnvironmentId.make("environment-local"),
      target: {
        httpBaseUrl: "http://localhost:3000",
        wsBaseUrl: "ws://localhost:3000",
      },
    },
    environmentId: EnvironmentId.make("environment-local"),
    client: {
      server: {
        subscribeAuthAccess: (listener: Parameters<typeof authAccessHarness.subscribe>[0]) =>
          authAccessHarness.subscribe(listener),
      },
    },
    ensureBootstrapped: async () => undefined,
    reconnect: async () => undefined,
    dispose: async () => undefined,
  };

  return {
    getEnvironmentHttpBaseUrl: () => "http://localhost:3000",
    getSavedEnvironmentRecord: () => null,
    getSavedEnvironmentRuntimeState: () => null,
    hasSavedEnvironmentRegistryHydrated: () => true,
    listSavedEnvironmentRecords: () => [],
    resetSavedEnvironmentRegistryStoreForTests: () => undefined,
    resetSavedEnvironmentRuntimeStoreForTests: () => undefined,
    resolveEnvironmentHttpUrl: (_environmentId: unknown, path: string) =>
      new URL(path, "http://localhost:3000").toString(),
    waitForSavedEnvironmentRegistryHydration: async () => undefined,
    addSavedEnvironment: vi.fn(),
    connectDesktopSshEnvironment: mockConnectDesktopSshEnvironment,
    disconnectSavedEnvironment: vi.fn(),
    ensureEnvironmentConnectionBootstrapped: async () => undefined,
    getPrimaryEnvironmentConnection: () => primaryConnection,
    readEnvironmentConnection: () => primaryConnection,
    reconnectSavedEnvironment: vi.fn(),
    removeSavedEnvironment: vi.fn(),
    requireEnvironmentConnection: () => primaryConnection,
    resetEnvironmentServiceForTests: () => undefined,
    startEnvironmentConnectionService: () => undefined,
    subscribeEnvironmentConnections: () => () => {},
    useSavedEnvironmentRegistryStore: (
      selector: (state: { byId: Record<string, never> }) => unknown,
    ) => selector({ byId: {} }),
    useSavedEnvironmentRuntimeStore: (
      selector: (state: { byId: Record<string, never> }) => unknown,
    ) => selector({ byId: {} }),
  };
});

function createBaseServerConfig(): ServerConfig {
  return {
    environment: {
      environmentId: EnvironmentId.make("environment-local"),
      label: "Local environment",
      platform: { os: "darwin" as const, arch: "arm64" as const },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "t3_session",
    },
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.t3code-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: ["cursor"],
    observability: {
      logsDirectoryPath: "/repo/project/.t3/logs",
      localTracingEnabled: true,
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpTracesEnabled: true,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

function createOutdatedProvider(
  driver: string,
  updateCommand = "npm install -g openai/codex@latest",
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-05-04T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      message: "Update available.",
      checkedAt: "2026-05-04T10:00:00.000Z",
      updateCommand,
      canUpdate: true,
    },
  };
}

function makeUtc(value: string) {
  return DateTime.makeUnsafe(value);
}

function createEmptyProcessResourceHistoryResult(): ServerProcessResourceHistoryResult {
  return {
    readAt: makeUtc("2036-04-07T00:00:00.000Z"),
    windowMs: 15 * 60_000,
    bucketMs: 60_000,
    sampleIntervalMs: 5_000,
    retainedSampleCount: 0,
    totalCpuSecondsApprox: 0,
    buckets: [],
    topProcesses: [],
    error: Option.none(),
  };
}

function makePairingLink(input: {
  readonly id: string;
  readonly credential: string;
  readonly role: "owner" | "client";
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}): AuthAccessSnapshot["pairingLinks"][number] {
  return {
    ...input,
    createdAt: makeUtc(input.createdAt),
    expiresAt: makeUtc(input.expiresAt),
  };
}

function makeClientSession(input: {
  readonly sessionId: string;
  readonly subject: string;
  readonly role: "owner" | "client";
  readonly method: "browser-session-cookie";
  readonly client?: {
    readonly label?: string;
    readonly ipAddress?: string;
    readonly userAgent?: string;
    readonly deviceType?: "desktop" | "mobile" | "tablet" | "bot" | "unknown";
    readonly os?: string;
    readonly browser?: string;
  };
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastConnectedAt?: string | null;
  readonly connected: boolean;
  readonly current: boolean;
}): AuthAccessSnapshot["clientSessions"][number] {
  return {
    ...input,
    client: {
      deviceType: "unknown",
      ...input.client,
    },
    sessionId: AuthSessionId.make(input.sessionId),
    issuedAt: makeUtc(input.issuedAt),
    expiresAt: makeUtc(input.expiresAt),
    lastConnectedAt:
      input.lastConnectedAt === undefined || input.lastConnectedAt === null
        ? null
        : makeUtc(input.lastConnectedAt),
  };
}

const createDesktopBridgeStub = (overrides?: {
  readonly discoverSshHosts?: DesktopBridge["discoverSshHosts"];
  readonly serverExposureState?: Awaited<ReturnType<DesktopBridge["getServerExposureState"]>>;
  readonly advertisedEndpoints?: Awaited<ReturnType<DesktopBridge["getAdvertisedEndpoints"]>>;
  readonly setServerExposureMode?: DesktopBridge["setServerExposureMode"];
  readonly setUpdateChannel?: DesktopBridge["setUpdateChannel"];
}): DesktopBridge => {
  const idleUpdateState: DesktopUpdateState = {
    enabled: false,
    status: "idle",
    channel: "latest",
    currentVersion: "0.0.0-test",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };

  return {
    getAppBranding: vi.fn().mockReturnValue(null),
    getLocalEnvironmentBootstrap: () => ({
      label: "Local environment",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
      bootstrapToken: "desktop-bootstrap-token",
    }),
    getClientSettings: vi.fn().mockResolvedValue(null),
    setClientSettings: vi.fn().mockResolvedValue(undefined),
    getSavedEnvironmentRegistry: vi.fn().mockResolvedValue([]),
    setSavedEnvironmentRegistry: vi.fn().mockResolvedValue(undefined),
    getSavedEnvironmentSecret: vi.fn().mockResolvedValue(null),
    setSavedEnvironmentSecret: vi.fn().mockResolvedValue(true),
    removeSavedEnvironmentSecret: vi.fn().mockResolvedValue(undefined),
    discoverSshHosts: overrides?.discoverSshHosts ?? vi.fn().mockResolvedValue([]),
    ensureSshEnvironment: vi.fn().mockImplementation(async (target) => ({
      target,
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
      pairingToken: "ssh-pairing-token",
    })),
    disconnectSshEnvironment: vi.fn().mockResolvedValue(undefined),
    fetchSshEnvironmentDescriptor: vi.fn().mockResolvedValue({
      environmentId: "environment-ssh",
      label: "SSH environment",
      platform: {
        os: "linux",
        arch: "x64",
      },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
      },
    }),
    bootstrapSshBearerSession: vi.fn().mockResolvedValue({
      authenticated: true,
      role: "owner",
      sessionMethod: "bearer-session-token",
      expiresAt: "2026-05-01T12:00:00.000Z",
      sessionToken: "ssh-bearer-token",
    }),
    fetchSshSessionState: vi.fn().mockResolvedValue({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie", "bearer-session-token"],
        sessionCookieName: "t3_session",
      },
      role: "owner",
      sessionMethod: "bearer-session-token",
      expiresAt: "2026-05-01T12:00:00.000Z",
    }),
    issueSshWebSocketToken: vi.fn().mockResolvedValue({
      token: "ssh-ws-token",
      expiresAt: "2026-05-01T12:05:00.000Z",
    }),
    onSshPasswordPrompt: vi.fn(() => () => {}),
    resolveSshPasswordPrompt: vi.fn().mockResolvedValue(undefined),
    getServerExposureState: vi.fn().mockResolvedValue(
      overrides?.serverExposureState ?? {
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
    ),
    setServerExposureMode:
      overrides?.setServerExposureMode ??
      vi.fn().mockImplementation(async (mode) => ({
        mode,
        endpointUrl: mode === "network-accessible" ? "http://192.168.1.44:3773" : null,
        advertisedHost: mode === "network-accessible" ? "192.168.1.44" : null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      })),
    setTailscaleServeEnabled: vi.fn().mockImplementation(async (input) => ({
      mode: overrides?.serverExposureState?.mode ?? "network-accessible",
      endpointUrl: overrides?.serverExposureState?.endpointUrl ?? "http://192.168.1.44:3773",
      advertisedHost: overrides?.serverExposureState?.advertisedHost ?? "192.168.1.44",
      tailscaleServeEnabled: input.enabled,
      tailscaleServePort: input.port ?? 443,
    })),
    getAdvertisedEndpoints: vi.fn().mockResolvedValue(overrides?.advertisedEndpoints ?? []),
    pickFolder: vi.fn().mockResolvedValue(null),
    confirm: vi.fn().mockResolvedValue(false),
    setTheme: vi.fn().mockResolvedValue(undefined),
    showContextMenu: vi.fn().mockResolvedValue(null),
    openExternal: vi.fn().mockResolvedValue(true),
    onMenuAction: () => () => {},
    getUpdateState: vi.fn().mockResolvedValue(idleUpdateState),
    setUpdateChannel:
      overrides?.setUpdateChannel ??
      vi.fn().mockImplementation(async (channel: DesktopUpdateChannel) => ({
        ...idleUpdateState,
        channel,
      })),
    checkForUpdate: vi.fn().mockResolvedValue({ checked: false, state: idleUpdateState }),
    downloadUpdate: vi
      .fn()
      .mockResolvedValue({ accepted: false, completed: false, state: idleUpdateState }),
    installUpdate: vi
      .fn()
      .mockResolvedValue({ accepted: false, completed: false, state: idleUpdateState }),
    onUpdateState: () => () => {},
  };
};

describe("GeneralSettingsPanel observability", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  beforeEach(async () => {
    resetServerStateForTests();
    await __resetLocalApiForTests();
    localStorage.clear();
    useUiStateStore.setState({ defaultAdvertisedEndpointKey: null });
    authAccessHarness.reset();
    mockConnectDesktopSshEnvironment.mockReset();
  });

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "desktopBridge");
    Reflect.deleteProperty(window, "nativeApi");
    document.body.innerHTML = "";
    resetServerStateForTests();
    await __resetLocalApiForTests();
    authAccessHarness.reset();
  });

  it("hides owner pairing tools in browser-served loopback builds without remote exposure", async () => {
    Reflect.deleteProperty(window, "desktopBridge");
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions: [
        makeClientSession({
          sessionId: "session-owner",
          subject: "browser-owner",
          role: "owner",
          method: "browser-session-cookie",
          client: {
            label: "Chrome on Mac",
            deviceType: "desktop",
            os: "macOS",
            browser: "Chrome",
            ipAddress: "127.0.0.1",
          },
          issuedAt: "2036-04-07T00:00:00.000Z",
          expiresAt: "2036-05-07T00:00:00.000Z",
          connected: true,
          current: true,
        }),
      ],
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/auth/session")) {
        return new Response(
          JSON.stringify({
            authenticated: true,
            auth: createBaseServerConfig().auth,
            role: "owner",
            sessionMethod: "browser-session-cookie",
            expiresAt: "2036-05-07T00:00:00.000Z",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error(`Unhandled fetch GET ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Manage local backend")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Enable network access")).toBeDisabled();
    await expect
      .element(
        page.getByText(
          "This backend is only reachable on this machine. Restart it with a non-loopback host to enable remote pairing.",
        ),
      )
      .toBeInTheDocument();
    await expect.element(page.getByText("Authorized clients")).not.toBeInTheDocument();
    await expect.element(page.getByText("Chrome on Mac")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Remote environments", exact: true }))
      .toBeInTheDocument();
  });

  it("hides advertised endpoint rows when desktop network access is disabled", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
      advertisedEndpoints: [
        {
          id: "loopback",
          label: "This machine",
          provider: {
            id: "desktop-core",
            label: "Desktop",
            kind: "manual",
            isAddon: false,
          },
          httpBaseUrl: "http://127.0.0.1:3773/",
          wsBaseUrl: "ws://127.0.0.1:3773/",
          reachability: "loopback",
          compatibility: {
            hostedHttpsApp: "mixed-content-blocked",
            desktopApp: "compatible",
          },
          source: "desktop-core",
          status: "available",
          isDefault: true,
        },
        {
          id: "tailscale-ip",
          label: "Tailscale IP",
          provider: {
            id: "tailscale",
            label: "Tailscale",
            kind: "private-network",
            isAddon: true,
          },
          httpBaseUrl: "http://100.105.39.17:3773/",
          wsBaseUrl: "ws://100.105.39.17:3773/",
          reachability: "private-network",
          compatibility: {
            hostedHttpsApp: "mixed-content-blocked",
            desktopApp: "compatible",
          },
          source: "desktop-addon",
          status: "available",
        },
      ],
    });
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions: [],
    });
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Limited to this machine.")).toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "This machine", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Tailscale IP", exact: true }))
      .not.toBeInTheDocument();
  });

  it("collapses advertised endpoints behind the network access summary", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "network-accessible",
        endpointUrl: "http://192.168.86.39:3773",
        advertisedHost: "192.168.86.39",
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
      advertisedEndpoints: [
        {
          id: "desktop-loopback:3773",
          label: "This machine",
          provider: {
            id: "desktop-core",
            label: "Desktop",
            kind: "manual",
            isAddon: false,
          },
          httpBaseUrl: "http://127.0.0.1:3773/",
          wsBaseUrl: "ws://127.0.0.1:3773/",
          reachability: "loopback",
          compatibility: {
            hostedHttpsApp: "mixed-content-blocked",
            desktopApp: "compatible",
          },
          source: "desktop-core",
          status: "available",
        },
        {
          id: "desktop-lan:http://192.168.86.39:3773",
          label: "Local network",
          provider: {
            id: "desktop-core",
            label: "Desktop",
            kind: "manual",
            isAddon: false,
          },
          httpBaseUrl: "http://192.168.86.39:3773/",
          wsBaseUrl: "ws://192.168.86.39:3773/",
          reachability: "lan",
          compatibility: {
            hostedHttpsApp: "mixed-content-blocked",
            desktopApp: "compatible",
          },
          source: "desktop-core",
          status: "available",
          isDefault: true,
        },
        {
          id: "tailscale-ip:http://100.105.39.17:3773",
          label: "Tailscale IP",
          provider: {
            id: "tailscale",
            label: "Tailscale",
            kind: "private-network",
            isAddon: true,
          },
          httpBaseUrl: "http://100.105.39.17:3773/",
          wsBaseUrl: "ws://100.105.39.17:3773/",
          reachability: "private-network",
          compatibility: {
            hostedHttpsApp: "mixed-content-blocked",
            desktopApp: "compatible",
          },
          source: "desktop-addon",
          status: "available",
        },
      ],
    });
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions: [],
    });
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("http://192.168.86.39:3773/")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "+2" })).toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Local network", exact: true }))
      .not.toBeInTheDocument();

    await page.getByRole("button", { name: "+2" }).click();

    await expect
      .element(page.getByRole("heading", { name: "Local network", exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByText("Default", { exact: true })).toBeInTheDocument();
    await page.getByRole("button", { name: "Set as default" }).first().click();
    await expect.element(page.getByText("http://127.0.0.1:3773/").first()).toBeInTheDocument();
  });

  it("shows diagnostics inside About with a diagnostics link", async () => {
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("About")).toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Diagnostics", exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByRole("link", { name: "View diagnostics" })).toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Local trace file. Exporting OTEL traces to http://localhost:4318/v1/traces.",
        ),
      )
      .toBeInTheDocument();
  });

  it("creates and shows a pairing link when network access is enabled", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "network-accessible",
        endpointUrl: "http://192.168.1.44:3773",
        advertisedHost: "192.168.1.44",
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
    });
    let pairingLinks: Array<AuthAccessSnapshot["pairingLinks"][number]> = [];
    let clientSessions: Array<AuthAccessSnapshot["clientSessions"][number]> = [
      makeClientSession({
        sessionId: "session-owner",
        subject: "desktop-bootstrap",
        role: "owner",
        method: "browser-session-cookie",
        client: {
          label: "This Mac",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
          ipAddress: "127.0.0.1",
        },
        issuedAt: "2036-04-07T00:00:00.000Z",
        expiresAt: "2036-05-07T00:00:00.000Z",
        connected: true,
        current: true,
      }),
    ];
    authAccessHarness.setSnapshot({
      pairingLinks,
      clientSessions,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/auth/pairing-token") && method === "POST") {
          pairingLinks = [
            makePairingLink({
              id: "pairing-link-1",
              credential: "pairing-token",
              role: "client",
              subject: "one-time-token",
              label: "Julius iPhone",
              createdAt: "2036-04-07T00:00:00.000Z",
              expiresAt: "2036-04-10T00:05:00.000Z",
            }),
          ];
          clientSessions = [
            ...clientSessions,
            makeClientSession({
              sessionId: "session-client",
              subject: "one-time-token",
              role: "client",
              method: "browser-session-cookie",
              client: {
                label: "Julius iPhone",
                deviceType: "mobile",
                os: "iOS",
                browser: "Safari",
                ipAddress: "192.168.1.88",
              },
              issuedAt: "2036-04-07T00:01:00.000Z",
              expiresAt: "2036-05-07T00:01:00.000Z",
              connected: false,
              current: false,
            }),
          ];
          authAccessHarness.setSnapshot({
            pairingLinks,
            clientSessions,
          });
          return new Response(
            JSON.stringify({
              id: "pairing-link-1",
              credential: "pairing-token",
              label: "Julius iPhone",
              expiresAt: "2036-04-10T00:05:00.000Z",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        throw new Error(`Unhandled fetch ${method} ${url}`);
      }),
    );

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Authorized clients")).toBeInTheDocument();
    await expect.element(page.getByText("Revoke others")).toBeInTheDocument();
    await expect.element(page.getByText("This Mac")).toBeInTheDocument();
    await page.getByRole("button", { name: "Create link", exact: true }).click();
    await expect.element(page.getByText("Create pairing link")).toBeInTheDocument();
    await page.getByRole("button", { name: "Create link", exact: true }).click();
    authAccessHarness.emitPairingLinkUpserted(pairingLinks[0]!);
    authAccessHarness.emitClientUpserted(clientSessions[1]!);
    await expect
      .element(page.getByText("Client · Mobile · iOS · Safari · 192.168.1.88"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: /^Copy pairing URL for:/ }))
      .toBeInTheDocument();
    await expect.element(page.getByText("Revoke others")).toBeInTheDocument();
  });

  it("revokes all other paired clients from settings", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "network-accessible",
        endpointUrl: "http://192.168.1.44:3773",
        advertisedHost: "192.168.1.44",
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
    });
    let clientSessions: Array<AuthAccessSnapshot["clientSessions"][number]> = [
      makeClientSession({
        sessionId: "session-owner",
        subject: "desktop-bootstrap",
        role: "owner",
        method: "browser-session-cookie",
        client: {
          label: "This Mac",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
        },
        issuedAt: "2036-04-05T00:00:00.000Z",
        expiresAt: "2036-05-05T00:00:00.000Z",
        connected: true,
        current: true,
      }),
      makeClientSession({
        sessionId: "session-client",
        subject: "one-time-token",
        role: "client",
        method: "browser-session-cookie",
        client: {
          label: "Julius iPhone",
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
          ipAddress: "192.168.1.88",
        },
        issuedAt: "2036-04-05T00:01:00.000Z",
        expiresAt: "2036-05-05T00:01:00.000Z",
        connected: false,
        current: false,
      }),
    ];
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions,
    });

    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/auth/clients/revoke-others") && method === "POST") {
        clientSessions = clientSessions.filter((session) => session.current);
        authAccessHarness.setSnapshot({
          pairingLinks: [],
          clientSessions,
        });
        authAccessHarness.emitClientRemoved("session-client");
        return new Response(JSON.stringify({ revokedCount: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unhandled fetch ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Julius iPhone")).toBeInTheDocument();
    await page.getByRole("button", { name: "Revoke others", exact: true }).click();
    await expect.element(page.getByText("This Mac")).toBeInTheDocument();
    await expect.element(page.getByText("Julius iPhone")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("shows a disabled network access toggle with guidance in desktop builds", async () => {
    const desktopBridge = createDesktopBridgeStub();
    window.desktopBridge = desktopBridge;

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    const networkAccessToggle = page.getByLabelText("Enable network access");
    await expect.element(networkAccessToggle).not.toBeDisabled();
    await networkAccessToggle.click();
    await expect.element(page.getByText("Enable network access?")).toBeInTheDocument();
    await expect
      .element(page.getByText("T3 Code will restart to expose this environment over the network."))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Restart and enable", exact: true }).click();
    await vi.waitFor(() => {
      expect(desktopBridge.setServerExposureMode).toHaveBeenCalledWith("network-accessible");
    });
    await expect.element(page.getByText("http://192.168.1.44:3773")).toBeInTheDocument();
  });

  it("adds desktop ssh environments from the add-environment dialog", async () => {
    const discoverSshHosts = vi.fn().mockResolvedValue([
      {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 22,
        source: "ssh-config" as const,
      },
    ]);
    window.desktopBridge = createDesktopBridgeStub({
      discoverSshHosts,
    });
    mockConnectDesktopSshEnvironment.mockResolvedValue({
      environmentId: EnvironmentId.make("environment-devbox"),
      label: "Build box",
      wsBaseUrl: "ws://127.0.0.1:3774/",
      httpBaseUrl: "http://127.0.0.1:3774/",
      createdAt: "2036-04-07T00:00:00.000Z",
      lastConnectedAt: "2036-04-07T00:00:00.000Z",
      desktopSsh: {
        alias: "devbox.example.com",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
      },
    });

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await page.getByRole("button", { name: "Add environment", exact: true }).click();
    const addEnvironmentDialog = page.getByRole("dialog", { name: "Add Environment" });
    await expect
      .element(addEnvironmentDialog.getByRole("heading", { name: "Add Environment", exact: true }))
      .toBeInTheDocument();
    await addEnvironmentDialog.getByRole("button", { name: /^SSH\b/ }).click();
    await vi.waitFor(() => {
      expect(discoverSshHosts).toHaveBeenCalledTimes(1);
    });
    await expect
      .element(page.getByRole("heading", { name: "devbox", exact: true }))
      .toBeInTheDocument();

    await addEnvironmentDialog.getByLabelText("SSH host or alias").fill("devbox.example.com");
    await addEnvironmentDialog.getByLabelText("Username").fill("julius");
    await addEnvironmentDialog.getByLabelText("Port").fill("2222");
    await addEnvironmentDialog
      .getByRole("button", { name: "Add environment", exact: true })
      .first()
      .click();

    await vi.waitFor(() => {
      expect(mockConnectDesktopSshEnvironment).toHaveBeenCalledWith(
        {
          alias: "devbox.example.com",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        },
        { label: "" },
      );
    });
  });

  it("opens the logs folder in the preferred editor", async () => {
    const openInEditor = vi.fn<LocalApi["shell"]["openInEditor"]>().mockResolvedValue(undefined);
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      shell: {
        openInEditor,
      },
      server: {
        getProcessDiagnostics: vi.fn().mockResolvedValue({
          serverPid: 1234,
          readAt: makeUtc("2036-04-07T00:00:00.000Z"),
          processCount: 0,
          totalRssBytes: 0,
          totalCpuPercent: 0,
          processes: [],
          error: Option.none(),
        }),
        getProcessResourceHistory: vi
          .fn()
          .mockResolvedValue(createEmptyProcessResourceHistoryResult()),
        getTraceDiagnostics: vi.fn().mockResolvedValue({
          traceFilePath: "/repo/project/.t3/traces.jsonl",
          scannedFilePaths: ["/repo/project/.t3/traces.jsonl"],
          readAt: makeUtc("2036-04-07T00:00:00.000Z"),
          recordCount: 0,
          parseErrorCount: 0,
          firstSpanAt: Option.none(),
          lastSpanAt: Option.none(),
          failureCount: 0,
          interruptionCount: 0,
          slowSpanThresholdMs: 5_000,
          slowSpanCount: 0,
          logLevelCounts: {},
          topSpansByCount: [],
          slowestSpans: [],
          commonFailures: [],
          latestFailures: [],
          latestWarningAndErrorLogs: [],
          partialFailure: Option.none(),
          error: Option.none(),
        }),
      },
    } as unknown as LocalApi;

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <DiagnosticsSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    const openLogsButton = page.getByLabelText("Open logs folder");
    await openLogsButton.click();

    expect(openInEditor).toHaveBeenCalledWith("/repo/project/.t3/logs", "cursor");
  });

  it("shows an OpenCode server URL field in provider settings", async () => {
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ProviderSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await page.getByLabelText("Toggle OpenCode details").click();

    // The unified provider-instance card renders field labels without a
    // driver-name prefix (the driver name is already shown in the card
    // header), so the labels read "Server URL" / "Server password"
    // rather than the old "OpenCode server URL" / "OpenCode server password".
    await expect.element(page.getByText("Server URL")).toBeInTheDocument();
    await expect.element(page.getByPlaceholder("http://127.0.0.1:4096")).toBeInTheDocument();
    await expect.element(page.getByText("Server password")).toBeInTheDocument();
    await expect.element(page.getByPlaceholder("Optional")).toBeInTheDocument();
  });

  it("runs one-click provider updates from the provider card", async () => {
    const updateProvider = vi.fn<LocalApi["server"]["updateProvider"]>().mockResolvedValue({
      providers: [createOutdatedProvider("codex")],
    });
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: {
        updateProvider,
      },
    } as unknown as LocalApi;

    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [createOutdatedProvider("codex")],
    });

    mounted = await render(
      <AppAtomRegistryProvider>
        <ProviderSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await page.getByRole("button", { name: "Update available — view details" }).click();
    await expect.element(page.getByRole("button", { name: "Update now" })).toBeInTheDocument();
    await page.getByRole("button", { name: "Update now" }).click();

    expect(updateProvider).toHaveBeenCalledWith({
      provider: ProviderDriverKind.make("codex"),
      instanceId: ProviderInstanceId.make("codex"),
    });
  });

  it("keeps long provider update commands inside the fixed-width popover", async () => {
    const longUpdateCommand =
      "npm install -g @anthropic-ai/claude-code@latest --registry=https://registry.npmjs.org --cache=/tmp/t3code-provider-update-cache";

    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [createOutdatedProvider("codex", longUpdateCommand)],
    });

    mounted = await render(
      <AppAtomRegistryProvider>
        <ProviderSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await page.getByRole("button", { name: "Update available — view details" }).click();
    await expect.element(page.getByText(longUpdateCommand)).toBeInTheDocument();

    await vi.waitFor(() => {
      const popup = document.querySelector<HTMLElement>('[data-slot="popover-popup"]');
      const commandCode = Array.from(document.querySelectorAll<HTMLElement>("code")).find(
        (element) => element.textContent === longUpdateCommand,
      );
      const scrollViewport = commandCode?.closest<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      );

      expect(popup).toBeTruthy();
      expect(commandCode).toBeTruthy();
      expect(scrollViewport).toBeTruthy();

      const popupRect = popup!.getBoundingClientRect();
      const viewportRect = scrollViewport!.getBoundingClientRect();

      expect(popupRect.width).toBeGreaterThan(300);
      expect(popupRect.width).toBeLessThanOrEqual(337);
      expect(viewportRect.right).toBeLessThanOrEqual(popupRect.right + 0.5);
      expect(scrollViewport!.scrollWidth).toBeGreaterThan(scrollViewport!.clientWidth);
    });
  });
});

describe("SourceControlSettingsPanel discovery states", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  beforeEach(async () => {
    resetAppAtomRegistryForTests();
    await __resetLocalApiForTests();
    document.body.innerHTML = "";
  });

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    Reflect.deleteProperty(window, "nativeApi");
    document.body.innerHTML = "";
    await __resetLocalApiForTests();
    resetAppAtomRegistryForTests();
  });

  function setSourceControlDiscoveryStub(
    discoverSourceControl: () => Promise<SourceControlDiscoveryResult>,
  ) {
    window.nativeApi = {
      server: {
        discoverSourceControl,
      },
    } as LocalApi;
  }

  it("shows skeleton sections while the first source control scan is pending", async () => {
    setSourceControlDiscoveryStub(() => new Promise(() => {}));

    mounted = await render(
      <AppAtomRegistryProvider>
        <SourceControlSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Version Control")).toBeInTheDocument();
    await expect.element(page.getByText("Source Control Providers")).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Rescan server environment" }))
      .toBeDisabled();
    await expect.element(page.getByText("Nothing detected yet")).not.toBeInTheDocument();
  });

  it("uses the shared empty state when discovery completes without tools", async () => {
    setSourceControlDiscoveryStub(async () => ({
      versionControlSystems: [],
      sourceControlProviders: [],
    }));

    mounted = await render(
      <AppAtomRegistryProvider>
        <SourceControlSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Nothing detected yet")).toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Install Git on the server, add optional hosting integrations or credentials your workspace needs, then rescan.",
        ),
      )
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Scan" })).toBeInTheDocument();
  });

  it("keeps discovered rows instead of showing the empty state", async () => {
    setSourceControlDiscoveryStub(async () => ({
      versionControlSystems: [
        {
          kind: "git",
          label: "Git",
          executable: "git",
          implemented: true,
          status: "available",
          version: Option.some("git version 2.50.0"),
          installHint: "Install Git.",
          detail: Option.none(),
        },
      ],
      sourceControlProviders: [],
    }));

    mounted = await render(
      <AppAtomRegistryProvider>
        <SourceControlSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByRole("switch", { name: "Git availability" })).toBeDisabled();
    await expect.element(page.getByText("Nothing detected yet")).not.toBeInTheDocument();
  });

  it("shows Git fetch interval settings inside the Git details dropdown", async () => {
    setSourceControlDiscoveryStub(async () => ({
      versionControlSystems: [
        {
          kind: "git",
          label: "Git",
          executable: "git",
          implemented: true,
          status: "available",
          version: Option.some("git version 2.50.0"),
          installHint: "Install Git.",
          detail: Option.none(),
        },
      ],
      sourceControlProviders: [],
    }));

    mounted = await render(
      <AppAtomRegistryProvider>
        <SourceControlSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    const toggle = page.getByRole("button", { name: "Toggle Git details" });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");

    await toggle.click();

    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
    await expect
      .element(page.getByLabelText("Automatic Git fetch interval in seconds"))
      .toBeVisible();
    await expect
      .element(page.getByText("Automatic Git fetches run every 30 seconds"))
      .not.toBeInTheDocument();
  });

  it("does not rescan on remount while the discovery atom is fresh", async () => {
    let calls = 0;
    setSourceControlDiscoveryStub(async () => {
      calls += 1;
      return {
        versionControlSystems: [
          {
            kind: "git",
            label: "Git",
            executable: "git",
            implemented: true,
            status: "available",
            version: Option.some("git version 2.50.0"),
            installHint: "Install Git.",
            detail: Option.none(),
          },
        ],
        sourceControlProviders: [],
      };
    });

    mounted = await render(
      <AppAtomRegistryProvider>
        <SourceControlSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByRole("switch", { name: "Git availability" })).toBeDisabled();
    expect(calls).toBe(1);

    const teardown = mounted.cleanup ?? mounted.unmount;
    await teardown?.call(mounted).catch(() => {});
    mounted = null;
    document.body.innerHTML = "";

    mounted = await render(
      <AppAtomRegistryProvider>
        <SourceControlSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByRole("switch", { name: "Git availability" })).toBeDisabled();
    expect(calls).toBe(1);
  });
});
