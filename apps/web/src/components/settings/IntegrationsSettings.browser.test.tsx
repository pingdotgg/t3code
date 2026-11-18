import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ProjectId, ServerConfig } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { ensureClientSettingsHydrated, persistClientSettingsPatch } from "../../hooks/useSettings";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { EnvironmentPresentation } from "../../state/environments";
import type { Project } from "../../types";

const environmentId = EnvironmentId.make("browser-settings");
const config = Schema.decodeSync(ServerConfig)({
  environment: {
    environmentId,
    label: "Desk",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "1.0.0",
    orchestrationProtocolVersion: 2,
    capabilities: {},
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie"],
    sessionCookieName: "t3_session",
  },
  cwd: "/workspace/browser",
  keybindingsConfigPath: "/workspace/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/workspace/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: {},
});
const environments: EnvironmentPresentation[] = [
  {
    environmentId,
    label: "Desk",
    displayUrl: "http://localhost:12345",
    relayManaged: false,
    entry: {
      target: new PrimaryConnectionTarget({
        environmentId,
        label: "Desk",
        httpBaseUrl: "http://localhost:12345",
        wsBaseUrl: "ws://localhost:12345/ws",
      }),
      profile: Option.none(),
      enabled: true,
    },
    connection: { phase: "connected", error: null, traceId: null },
    refusedRouteIds: [],
    serverConfig: config,
  },
];
const projects: Project[] = [
  {
    id: ProjectId.make("browser-project"),
    environmentId,
    title: "Browser project",
    workspaceRoot: "/workspace/browser",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T00:00:00.000Z",
  },
];

// Profiles, link target and the advanced rows only work in the desktop app.
vi.mock(import("../../env"), async (original) => ({ ...(await original()), isElectron: true }));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: () => ({
    isReady: true,
    networkStatus: "online" as const,
    environments,
    presentationById: new Map(),
  }),
  usePrimaryEnvironmentId: () => environmentId,
  usePrimaryEnvironment: () => environments[0]!,
  readEnvironment: () => environments[0]!,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set([environmentId]),
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => projects,
  useServerConfigs: () => new Map([[environmentId, config]]),
}));
const deviceTest = vi.hoisted(() => ({ configure: vi.fn(), toast: vi.fn() }));
vi.mock(import("../../state/device"), async (original) => ({
  ...(await original()),
  useDeviceState: () => ({
    state: {
      hosts: [],
      hostStatus: "disabled",
      hostStatuses: {},
      devices: [],
      sessions: [],
      onboardingCompleted: false,
      agentAccessEnabled: false,
      hubBasePath: "/api/device-hub",
      revision: 0,
    },
    loaded: true,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => deviceTest.configure) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: deviceTest.toast } };
});

import { BrowserSettingsPanel, DevicesSettingsPanel } from "./IntegrationsSettings";
import { SettingsScopeProvider } from "./SettingsScopeContext";

const [group] = buildSidebarProjectSnapshots({
  projects,
  settings: DEFAULT_CLIENT_SETTINGS,
  primaryEnvironmentId: environmentId,
  resolveEnvironmentLabel: () => "Desk",
});
const isInert = (element: Element) => element.closest("[inert]") !== null;

it.each([
  { scope: "a project", search: { project: group!.projectKey } },
  {
    scope: "a checkout",
    search: { project: group!.projectKey, checkout: group!.memberProjects[0]!.physicalProjectKey },
  },
])("shows device preferences read-only for $scope", async ({ search }) => {
  await ensureClientSettingsHydrated();
  await persistClientSettingsPatch(
    { browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }] },
    async () => {},
  );
  await using screen = await render(
    <SettingsScopeProvider search={search} onChange={() => {}}>
      <BrowserSettingsPanel />
    </SettingsScopeProvider>,
    { router: "/settings/browser" },
  );

  for (const name of ["Search engine", "Open links in"]) {
    expect(isInert(screen.getByRole("combobox", { name }).element())).toBe(true);
  }
  expect(isInert(screen.getByRole("switch", { name: "Agent browser access" }).element())).toBe(
    false,
  );
  // Profiles save for this device in every scope, but the default profile is a device preference.
  await expect.element(screen.getByRole("button", { name: "Add profile" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Work options" }));
  await expect
    .element(page.getByRole("menuitem", { name: "Set as default" }))
    .toHaveAttribute("aria-disabled", "true");
});

const OFFLINE_STATUS = "Offline machines will not get this setting: Laptop and Studio.";

// Desk stays connected with both device switches on; Laptop and Studio are offline saved machines.
function setupDevices() {
  const desk = environments[0]!;
  const settings = { ...config.settings, enableDeviceSupport: true, enableAgentDeviceAccess: true };
  const laptop: EnvironmentPresentation = {
    ...desk,
    environmentId: EnvironmentId.make("laptop"),
    label: "Laptop",
    connection: { phase: "offline", error: null, traceId: null },
    serverConfig: null,
  };
  const studio = { ...laptop, environmentId: EnvironmentId.make("studio"), label: "Studio" };
  environments.splice(0, 1, { ...desk, serverConfig: { ...config, settings } }, laptop, studio);
  deviceTest.configure.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  deviceTest.toast.mockReset();
  return { [Symbol.dispose]: () => void environments.splice(0, Infinity, desk) };
}

const renderDevices = () =>
  render(
    <SettingsScopeProvider search={{}} onChange={() => {}}>
      <DevicesSettingsPanel />
    </SettingsScopeProvider>,
    { router: "/settings/devices" },
  );

it("turning off the device hub updates connected environments and names the offline ones", async () => {
  using _devices = setupDevices();
  await using screen = await renderDevices();
  const hub = screen.getByRole("switch", { name: "Device hub" });

  await userEvent.click(hub);
  await expect.element(hub).toBeEnabled();
  expect(deviceTest.configure.mock.calls).toEqual([
    [{ environmentId, input: { enabled: false, agentAccessEnabled: false } }],
  ]);
  expect(deviceTest.toast).not.toHaveBeenCalled();
  expect(screen.getByText(OFFLINE_STATUS).elements()).toHaveLength(2);
});

it("reports a failed save on a connected environment and still names the offline ones", async () => {
  using _devices = setupDevices();
  deviceTest.configure.mockResolvedValue({ _tag: "Failure", cause: new Error("denied") });
  await using screen = await renderDevices();
  const hub = screen.getByRole("switch", { name: "Device hub" });

  await userEvent.click(hub);
  await expect.element(hub).toBeEnabled();
  expect(deviceTest.toast).toHaveBeenCalledWith({
    type: "error",
    title: "Device settings not saved on all environments",
    description: "Could not update Desk.",
  });
  expect(screen.getByText(OFFLINE_STATUS).elements()).toHaveLength(2);
});
