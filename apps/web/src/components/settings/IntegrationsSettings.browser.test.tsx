import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ProjectId, ServerConfig } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

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
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => projects,
  useServerConfigs: () => new Map([[environmentId, config]]),
}));

import { BrowserSettingsPanel } from "./IntegrationsSettings";
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
