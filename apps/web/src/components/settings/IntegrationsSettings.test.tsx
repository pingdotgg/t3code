import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  type DeviceServiceState,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, StrictMode, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { listBrowserImportSources } = vi.hoisted(() => ({
  listBrowserImportSources: vi.fn().mockResolvedValue([]),
}));

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactNode; children: ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
  TooltipPopup: () => null,
}));
vi.mock("../preview/previewBridge", () => ({
  previewBridge: { listBrowserImportSources },
}));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [], isReady: true }),
  usePrimaryEnvironment: () => null,
  // Settings rows resolve the primary grant before rendering server controls.
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE: "Connect to an environment",
  useClientSettings: (selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
  useClientSettingsHydrated: () => true,
  usePrimarySettingsAvailable: () => true,
  usePrimarySettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdatePrimarySettings: () => vi.fn(),
}));
vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
}));
// The scoped agent-access rows need the settings layout's scope provider;
// this test covers the device-local browser sections only.
vi.mock("./ProjectDefaultsSettings", () => ({ ProjectDefaultsSettings: () => null }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: [] },
    search: {},
    environment: null,
    environments: [],
    target: null,
    connectedEnvironments: [],
    targets: [],
  }),
  useOptionalSettingsScope: () => null,
}));

import { IntegrationsSettingsPanel } from "./IntegrationsSettings";
import {
  isAndroidDiscoveryUncertain,
  isDiscoveryLimited,
  platformSetupStatus,
} from "../device/DeviceSetup";

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listBrowserImportSources.mockClear();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function openSettings() {
  const router = createRouter({
    routeTree: createRootRoute({ component: IntegrationsSettingsPanel }),
    history: createMemoryHistory(),
  });
  await router.load();
  await act(() => {
    renderer = create(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    );
  });
  expect(renderer!.root.findByType(IntegrationsSettingsPanel)).toBeDefined();
}

describe("Integrations browser discovery", () => {
  it("does not scan browser files when entering or revisiting settings", async () => {
    await openSettings();
    expect(listBrowserImportSources).not.toHaveBeenCalled();

    await act(() => renderer?.unmount());
    await openSettings();
    expect(listBrowserImportSources).not.toHaveBeenCalled();
  });

  it("places device settings directly after browser settings", async () => {
    await openSettings();
    const sections = renderer!.root
      .findAll((node) => node.type === "section")
      .map((node) => node.props.id)
      .filter(Boolean);
    expect(sections.indexOf("devices")).toBeGreaterThan(sections.indexOf("browser"));
  });
});

const deviceState = (overrides: Partial<DeviceServiceState> = {}): DeviceServiceState => ({
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "This machine",
      hubInstalled: false,
      agentDeviceInstalled: false,
      platforms: [
        { platform: "ios", available: true },
        { platform: "android", available: true },
      ],
    },
  ],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: "/api/device-hub",
  revision: 0,
  ...overrides,
});

describe("device setup guidance", () => {
  it("keeps Android availability uncertain after a local discovery warning", () => {
    const state = deviceState({
      hostStatuses: {
        local: {
          status: "ready",
          detail: "A device inventory could not be inspected.",
          androidDiscoveryIncomplete: true,
        },
      },
    });
    const android = platformSetupStatus(state, "android");
    expect(android.ready).toBe(false);
    expect(android.message).toContain("may be incomplete");
    expect(android.message).not.toContain("Device Manager");
    expect(platformSetupStatus(state, "ios").message).toContain("Xcode Settings");

    const recovered = deviceState({ hostStatuses: { local: { status: "ready" } } });
    expect(platformSetupStatus(recovered, "android").message).toContain("Device Manager");
  });

  const local = deviceState().hosts[0]!;
  const remote = {
    ...local,
    id: "remote",
    kind: "ssh" as const,
    label: "Mac mini",
    platforms: [{ platform: "android" as const, available: true }],
  };
  it.each([
    { localCase: "failed", localStatus: "failed" as const, localAndroid: true },
    { localCase: "without Android", localStatus: "ready" as const, localAndroid: false },
  ])("reports a remote discovery warning when the local host is $localCase", (input) => {
    const state = deviceState({
      hosts: [
        {
          ...local,
          platforms: [{ platform: "android", available: input.localAndroid }],
        },
        remote,
      ],
      hostStatus: input.localStatus,
      hostStatuses: {
        local: { status: input.localStatus },
        remote: {
          status: "ready",
          detail: "Could not list Android virtual devices.",
          androidDiscoveryIncomplete: true,
        },
      },
    });
    const android = platformSetupStatus(state, "android");
    expect(android.ready).toBe(false);
    expect(android.message).toContain("may be incomplete");
  });

  it("keeps the missing-tool explanation when the warning host has no Android support", () => {
    const state = deviceState({
      hosts: [
        {
          ...local,
          platforms: [
            { platform: "android", available: false, reason: "Android Emulator is missing." },
          ],
        },
        { ...remote, platforms: [{ platform: "ios", available: true }] },
      ],
      hostStatuses: {
        local: { status: "ready" },
        remote: { status: "ready", detail: "One simulator could not be inspected." },
      },
    });
    expect(platformSetupStatus(state, "android").message).toBe("Android Emulator is missing.");
  });

  it("keeps Android creation advice when only a host without Android reports a warning", () => {
    const state = deviceState({
      hosts: [local, { ...remote, platforms: [{ platform: "ios", available: true }] }],
      hostStatuses: {
        local: { status: "ready" },
        remote: { status: "ready", detail: "One simulator could not be inspected." },
      },
    });
    expect(isDiscoveryLimited(state)).toBe(true);
    expect(isAndroidDiscoveryUncertain(state)).toBe(false);
    expect(platformSetupStatus(state, "android").message).toContain("Device Manager");
  });

  it("keeps Android creation advice when a dual-platform host reports only an iOS warning", () => {
    const state = deviceState({
      hostStatuses: {
        local: { status: "ready", detail: "One iOS simulator could not be inspected." },
      },
    });
    expect(isDiscoveryLimited(state)).toBe(true);
    expect(isAndroidDiscoveryUncertain(state)).toBe(false);
    expect(platformSetupStatus(state, "android").message).toContain("Device Manager");
  });

  it("keeps discovered Android devices available while discovery is limited", () => {
    const state = deviceState({
      hostStatuses: { local: { status: "ready", detail: "Stopped devices could not be listed." } },
      devices: [
        {
          hostId: "local",
          id: "phone-1",
          name: "Pixel",
          platform: "android",
          version: "36",
          booted: true,
          physical: true,
        },
      ],
    });
    expect(platformSetupStatus(state, "android").ready).toBe(true);
  });

  it("directs users to install an iOS runtime and create an Android virtual device", () => {
    expect(platformSetupStatus(deviceState(), "ios").message).toContain("Xcode Settings");
    expect(platformSetupStatus(deviceState(), "android").message).toContain("Device Manager");
  });

  it("preserves a specific missing-tool explanation from the server", () => {
    const state = deviceState({
      hosts: [
        {
          ...deviceState().hosts[0]!,
          platforms: [
            { platform: "ios", available: true },
            { platform: "android", available: false, reason: "Android Emulator is missing." },
          ],
        },
      ],
    });
    expect(platformSetupStatus(state, "android").message).toBe("Android Emulator is missing.");
  });
});
