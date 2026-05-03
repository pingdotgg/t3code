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
  type ServerConfig,
} from "@forma/contracts";
import { DateTime } from "effect";
import type { ReactNode } from "react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { __resetLocalApiForTests } from "../../localApi";
import { CLIENT_SETTINGS_STORAGE_KEY } from "../../clientPersistenceStorage";
import { __resetClientSettingsPersistenceForTests } from "../../hooks/useSettings";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { THEME_STORAGE_KEY } from "../../theme";
import { ConnectionsSettings } from "./ConnectionsSettings";
import {
  AdvancedSettingsPanel,
  InterfaceSettingsPanel,
  NotificationsSettingsPanel,
  ProvidersSettingsPanel,
  ThreadsSettingsPanel,
  useSettingsRestore,
} from "./SettingsPanels";

vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    confirmAndDeleteThread: vi.fn(async () => undefined),
    unarchiveThread: vi.fn(async () => undefined),
  }),
}));

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
    keybindingsConfigPath: "/repo/project/.forma-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: ["cursor"],
    observability: {
      logsDirectoryPath: "/repo/project/.forma/logs",
      localTracingEnabled: true,
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpTracesEnabled: true,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

function makeUtc(value: string) {
  return DateTime.makeUnsafe(Date.parse(value));
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
  readonly serverExposureState?: Awaited<ReturnType<DesktopBridge["getServerExposureState"]>>;
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
    getServerExposureState: vi.fn().mockResolvedValue(
      overrides?.serverExposureState ?? {
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
      },
    ),
    setServerExposureMode:
      overrides?.setServerExposureMode ??
      vi.fn().mockImplementation(async (mode) => ({
        mode,
        endpointUrl: mode === "network-accessible" ? "http://192.168.1.44:3773" : null,
        advertisedHost: mode === "network-accessible" ? "192.168.1.44" : null,
      })),
    pickFolder: vi.fn().mockResolvedValue(null),
    confirm: vi.fn().mockResolvedValue(false),
    setTheme: vi.fn().mockResolvedValue(undefined),
    showContextMenu: vi.fn().mockResolvedValue(null),
    openExternal: vi.fn().mockResolvedValue(true),
    notifyThreadAttention: vi.fn().mockResolvedValue(false),
    onThreadAttentionActivated: () => () => {},
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

function SettingsRestoreHarness({
  buttonLabel,
  scope,
}: {
  buttonLabel: string;
  scope: Parameters<typeof useSettingsRestore>[0];
}) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(scope);

  return (
    <button disabled={changedSettingLabels.length === 0} onClick={() => void restoreDefaults()}>
      {buttonLabel}
    </button>
  );
}

async function selectOption(label: string, option: string) {
  await page.getByLabelText(label).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

function setRangeInputValue(label: string, value: number) {
  const input = document.querySelector(`[aria-label="${label}"]`);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Expected the ${label} range input.`);
  }

  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setValue?.call(input, String(value));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Settings panels", () => {
  const originalMatchMedia = window.matchMedia.bind(window);
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  function stubMatchMedia(matches: boolean) {
    const matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: matchMedia,
      writable: true,
    });

    return matchMedia;
  }

  async function renderSettingsPanel(panel: ReactNode) {
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(<AppAtomRegistryProvider>{panel}</AppAtomRegistryProvider>);
  }

  beforeEach(async () => {
    resetServerStateForTests();
    await __resetLocalApiForTests();
    __resetClientSettingsPersistenceForTests();
    localStorage.clear();
    authAccessHarness.reset();
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
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
      writable: true,
    });
    document.body.innerHTML = "";
    resetServerStateForTests();
    await __resetLocalApiForTests();
    __resetClientSettingsPersistenceForTests();
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

  it("shows diagnostics and logs access on the Advanced page", async () => {
    await renderSettingsPanel(<AdvancedSettingsPanel />);

    await expect.element(page.getByText("Diagnostics")).toBeInTheDocument();
    await expect.element(page.getByText("Updates")).toBeInTheDocument();
    await expect.element(page.getByText("Open logs folder")).toBeInTheDocument();
    await expect
      .element(page.getByText("/repo/project/.forma/logs", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Local trace file. OTLP exporting traces to http://localhost:4318/v1/traces.",
        ),
      )
      .toBeInTheDocument();
  });

  it("renders the custom theme builder instead of preset theme cards", async () => {
    await renderSettingsPanel(<InterfaceSettingsPanel />);

    await expect.element(page.getByLabelText("Theme mode")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Theme hue")).toBeInTheDocument();
    await expect.element(page.getByText("Hue", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Saturation", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByLabelText("Theme saturation")).toBeInTheDocument();
    expect(document.querySelector('[data-theme-preview-card="true"]')).toBeNull();
    expect(document.querySelector('[aria-label="Theme hue wheel"]')).toBeNull();
  });

  it("updates stored and document theme state when editing the custom theme", async () => {
    await renderSettingsPanel(<InterfaceSettingsPanel />);

    await selectOption("Theme mode", "Dark");

    setRangeInputValue("Theme hue", 288);
    setRangeInputValue("Theme saturation", 44);

    await vi.waitFor(() => {
      expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? "{}")).toMatchObject({
        version: 2,
        mode: "dark",
        hue: 288,
        saturation: 44,
      });
      expect(document.documentElement.dataset.themePreferenceMode).toBe("dark");
      expect(document.documentElement.dataset.themeMode).toBe("dark");
      expect(document.documentElement.dataset.themeHue).toBe("288");
      expect(document.documentElement.dataset.themeSaturation).toBe("44");
    });
  });

  it("keeps system mode selected while resolving dark mode from the OS", async () => {
    localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        mode: "system",
        hue: 222,
        saturation: 68,
      }),
    );
    stubMatchMedia(true);

    await renderSettingsPanel(<InterfaceSettingsPanel />);

    await vi.waitFor(() => {
      expect(document.querySelector('[aria-label="Theme mode"]')?.textContent).toContain("System");
      expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? "{}")).toMatchObject({
        version: 2,
        mode: "system",
      });
      expect(document.documentElement.dataset.themePreferenceMode).toBe("system");
      expect(document.documentElement.dataset.themeMode).toBe("dark");
    });
  });

  it("resets theme selection back to system", async () => {
    await renderSettingsPanel(<InterfaceSettingsPanel />);

    await selectOption("Theme mode", "Dark");

    await vi.waitFor(() => {
      expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? "{}")).toMatchObject({
        mode: "dark",
      });
    });

    await page.getByRole("button", { name: "Reset theme to default" }).click();

    await vi.waitFor(() => {
      expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? "{}")).toMatchObject({
        version: 2,
        mode: "system",
        hue: 222,
        saturation: 68,
      });
      expect(document.documentElement.dataset.themePreferenceMode).toBe("system");
      expect(document.querySelector('[aria-label="Theme mode"]')?.textContent).toContain("System");
    });
  });

  it("persists interface typography settings and shows the macOS smoothing control", async () => {
    await renderSettingsPanel(<InterfaceSettingsPanel />);

    await page.getByLabelText("UI font size").fill("11");
    (document.querySelector('[aria-label="UI font size"]') as HTMLInputElement | null)?.blur();
    document
      .querySelector('[aria-label="UI font size"]')
      ?.dispatchEvent(new FocusEvent("blur", { bubbles: true }));

    await page.getByLabelText("Code font size").fill("15");
    (document.querySelector('[aria-label="Code font size"]') as HTMLInputElement | null)?.blur();
    document
      .querySelector('[aria-label="Code font size"]')
      ?.dispatchEvent(new FocusEvent("blur", { bubbles: true }));

    await page.getByLabelText("Font smoothing").click();

    await vi.waitFor(() => {
      const persisted = JSON.parse(localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY) ?? "{}") as {
        uiFontScale?: number;
        codeFontScale?: number;
        macOsFontSmoothing?: string;
      };
      expect(persisted.uiFontScale).toBe(11);
      expect(persisted.codeFontScale).toBe(15);
      expect(persisted.macOsFontSmoothing).toBe("grayscale");
    });
  });

  it("hides font smoothing outside macOS", async () => {
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      environment: {
        ...createBaseServerConfig().environment,
        platform: { os: "linux", arch: "x64" },
      },
    });

    mounted = await render(
      <AppAtomRegistryProvider>
        <InterfaceSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByLabelText("UI font size")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Code font size")).toBeInTheDocument();
    expect(document.querySelector('[aria-label="Font smoothing"]')).toBeNull();
  });

  it("persists and resets the thread cleanup window", async () => {
    await renderSettingsPanel(<ThreadsSettingsPanel />);

    const cleanupWindowTrigger = page.getByLabelText("Thread cleanup window");
    await expect.element(cleanupWindowTrigger).toBeInTheDocument();
    await cleanupWindowTrigger.click();
    await page.getByText("7 days").click();

    await vi.waitFor(() => {
      const persisted = JSON.parse(localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY) ?? "{}") as {
        threadCleanupInactiveDays?: number;
      };
      expect(persisted.threadCleanupInactiveDays).toBe(7);
      expect(document.querySelector('[aria-label="Thread cleanup window"]')?.textContent).toContain(
        "7 days",
      );
    });

    await page.getByRole("button", { name: "Reset thread cleanup window to default" }).click();

    await vi.waitFor(() => {
      const persisted = JSON.parse(localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY) ?? "{}") as {
        threadCleanupInactiveDays?: number;
      };
      expect(persisted.threadCleanupInactiveDays).toBe(1);
      expect(document.querySelector('[aria-label="Thread cleanup window"]')?.textContent).toContain(
        "1 day",
      );
    });
  });

  it("keeps desktop attention notification controls out of the Threads page", async () => {
    await renderSettingsPanel(<ThreadsSettingsPanel />);

    await expect.element(page.getByText("Thread attention")).not.toBeInTheDocument();
    await expect
      .element(page.getByLabelText("Approval request notifications"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByLabelText("Question prompt notifications"))
      .not.toBeInTheDocument();
  });

  it("shows desktop notification availability state when the desktop bridge is missing", async () => {
    await renderSettingsPanel(<NotificationsSettingsPanel />);

    await expect.element(page.getByText("Thread attention")).toBeInTheDocument();
    await expect.element(page.getByText("Desktop notifications unavailable")).toBeInTheDocument();
    await expect
      .element(page.getByText(/Open Forma in the desktop app to receive attention notifications/i))
      .toBeInTheDocument();
    await expect
      .element(page.getByLabelText("Approval request notifications"))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByLabelText("Question prompt notifications"))
      .not.toBeInTheDocument();
  });

  it("persists and resets desktop attention notification controls", async () => {
    const desktopBridge = createDesktopBridgeStub();
    const setClientSettings = vi.mocked(desktopBridge.setClientSettings);
    window.desktopBridge = desktopBridge;
    await renderSettingsPanel(<NotificationsSettingsPanel />);

    await page.getByRole("switch", { name: "Approval request notifications" }).click();
    await page.getByRole("switch", { name: "Question prompt notifications" }).click();

    await vi.waitFor(() => {
      expect(
        document
          .querySelector('[aria-label="Approval request notifications"]')
          ?.getAttribute("aria-checked"),
      ).toBe("true");
      expect(
        document
          .querySelector('[aria-label="Question prompt notifications"]')
          ?.getAttribute("aria-checked"),
      ).toBe("true");
      expect(setClientSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({
          desktopNotifyOnApprovalRequests: true,
          desktopNotifyOnUserInputRequests: true,
        }),
      );
    });

    await page
      .getByRole("button", { name: "Reset approval request notifications to default" })
      .click();
    await page
      .getByRole("button", { name: "Reset question prompt notifications to default" })
      .click();

    await vi.waitFor(() => {
      expect(
        document
          .querySelector('[aria-label="Approval request notifications"]')
          ?.getAttribute("aria-checked"),
      ).toBe("false");
      expect(
        document
          .querySelector('[aria-label="Question prompt notifications"]')
          ?.getAttribute("aria-checked"),
      ).toBe("false");
      expect(setClientSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({
          desktopNotifyOnApprovalRequests: false,
          desktopNotifyOnUserInputRequests: false,
        }),
      );
    });
  });

  it("restores desktop attention notification controls through the notifications restore flow", async () => {
    const desktopBridge = createDesktopBridgeStub();
    const setClientSettings = vi.mocked(desktopBridge.setClientSettings);
    desktopBridge.confirm = vi.fn().mockResolvedValue(true);
    window.desktopBridge = desktopBridge;
    window.nativeApi = {
      dialogs: {
        confirm: desktopBridge.confirm,
      },
      persistence: {
        getClientSettings: desktopBridge.getClientSettings,
        setClientSettings: desktopBridge.setClientSettings,
      },
      server: {
        updateSettings: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as LocalApi;

    await renderSettingsPanel(
      <>
        <NotificationsSettingsPanel />
        <SettingsRestoreHarness buttonLabel="Restore notification defaults" scope="notifications" />
      </>,
    );

    await page.getByRole("switch", { name: "Approval request notifications" }).click();
    await page.getByRole("switch", { name: "Question prompt notifications" }).click();

    await vi.waitFor(() => {
      expect(
        document
          .querySelector('[aria-label="Approval request notifications"]')
          ?.getAttribute("aria-checked"),
      ).toBe("true");
      expect(
        document
          .querySelector('[aria-label="Question prompt notifications"]')
          ?.getAttribute("aria-checked"),
      ).toBe("true");
      expect(setClientSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({
          desktopNotifyOnApprovalRequests: true,
          desktopNotifyOnUserInputRequests: true,
        }),
      );
    });

    await page.getByRole("button", { name: "Restore notification defaults" }).click();

    await vi.waitFor(() => {
      expect(
        document
          .querySelector('[aria-label="Approval request notifications"]')
          ?.getAttribute("aria-checked"),
      ).toBe("false");
      expect(
        document
          .querySelector('[aria-label="Question prompt notifications"]')
          ?.getAttribute("aria-checked"),
      ).toBe("false");
      expect(setClientSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({
          desktopNotifyOnApprovalRequests: false,
          desktopNotifyOnUserInputRequests: false,
        }),
      );
    });
  });

  it("creates and shows a pairing link when network access is enabled", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "network-accessible",
        endpointUrl: "http://192.168.1.44:3773",
        advertisedHost: "192.168.1.44",
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
      .element(page.getByRole("button", { name: /^(Copy|Show link)$/ }))
      .toBeInTheDocument();
    await expect.element(page.getByText("Revoke others")).toBeInTheDocument();
  });

  it("revokes all other paired clients from settings", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "network-accessible",
        endpointUrl: "http://192.168.1.44:3773",
        advertisedHost: "192.168.1.44",
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
      .element(page.getByText("Forma will restart to expose this environment over the network."))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Restart and enable", exact: true }).click();
    await vi.waitFor(() => {
      expect(desktopBridge.setServerExposureMode).toHaveBeenCalledWith("network-accessible");
    });
    await expect
      .element(page.getByText("Reachable at http://192.168.1.44:3773"))
      .toBeInTheDocument();
  });

  it("opens the logs folder in the preferred editor", async () => {
    const openInEditor = vi.fn<LocalApi["shell"]["openInEditor"]>().mockResolvedValue(undefined);
    window.nativeApi = {
      shell: {
        openInEditor,
      },
    } as unknown as LocalApi;

    await renderSettingsPanel(<AdvancedSettingsPanel />);

    const openLogsButton = page.getByText("Open logs folder");
    await openLogsButton.click();

    expect(openInEditor).toHaveBeenCalledWith("/repo/project/.forma/logs", "cursor");
  });

  it("shows an OpenCode server URL field in provider settings", async () => {
    await renderSettingsPanel(<ProvidersSettingsPanel />);

    await page.getByLabelText("Toggle OpenCode details").click();

    await expect.element(page.getByText("OpenCode server URL")).toBeInTheDocument();
    await expect.element(page.getByPlaceholder("http://127.0.0.1:4096")).toBeInTheDocument();
    await expect.element(page.getByText("OpenCode server password")).toBeInTheDocument();
    await expect.element(page.getByPlaceholder("Server password")).toBeInTheDocument();
  });

  it("removes custom provider models from the list immediately", async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    window.nativeApi = {
      server: {
        updateSettings,
      },
    } as unknown as LocalApi;

    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [
        {
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          version: "0.128.0",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-05-02T00:00:00.000Z",
          message: undefined,
          models: [
            {
              slug: "gpt-5.5",
              name: "GPT-5.5",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "5.5",
              name: "5.5",
              isCustom: true,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        },
      ],
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            customModels: ["5.5"],
          },
        },
      },
    });

    mounted = await render(
      <AppAtomRegistryProvider>
        <ProvidersSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await page.getByLabelText("Toggle Codex details").click();
    await expect.element(page.getByRole("button", { name: "Remove 5.5" })).toBeInTheDocument();

    await page.getByRole("button", { name: "Remove 5.5" }).click();

    await expect.element(page.getByRole("button", { name: "Remove 5.5" })).not.toBeInTheDocument();
    expect(updateSettings).toHaveBeenCalledWith({
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          customModels: [],
        },
        claudeAgent: DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
        cursor: DEFAULT_SERVER_SETTINGS.providers.cursor,
        opencode: DEFAULT_SERVER_SETTINGS.providers.opencode,
      },
    });
  });
});
