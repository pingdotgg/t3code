import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ProjectId, ServerConfig } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";
import {
  ensureClientSettingsHydrated,
  getClientSettings,
  persistClientSettingsPatch,
} from "../../hooks/useSettings";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { EnvironmentPresentation } from "../../state/environments";
import type { Project } from "../../types";

const environmentId = EnvironmentId.make("labs-settings");
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
  cwd: "/workspace/labs",
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
    id: ProjectId.make("labs-project"),
    environmentId,
    title: "Labs project",
    workspaceRoot: "/workspace/labs",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T00:00:00.000Z",
  },
];

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

import { LabsSettingsPanel } from "./LabsSettingsPanel";
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
])("shows Boring sidebar device preferences read-only for $scope", async ({ search }) => {
  await ensureClientSettingsHydrated();
  await persistClientSettingsPatch(
    { boringSidebarEnabled: true, boringSidebarMultilineRows: false },
    async () => {},
  );
  await using screen = await render(
    <SettingsScopeProvider search={search} onChange={() => {}}>
      <LabsSettingsPanel />
    </SettingsScopeProvider>,
    { router: "/settings/labs" },
  );

  for (const name of ["Boring sidebar (group by project)", "Two-line folder rows"]) {
    expect(isInert(screen.getByRole("switch", { name }).element())).toBe(true);
  }
});

it.each([
  { scope: "All projects", search: {} },
  { scope: "an environment", search: { machine: environmentId } },
])("saves Boring sidebar device preferences for $scope", async ({ search }) => {
  await ensureClientSettingsHydrated();
  await persistClientSettingsPatch(
    { boringSidebarEnabled: false, boringSidebarMultilineRows: false },
    async () => {},
  );
  await using screen = await render(
    <SettingsScopeProvider search={search} onChange={() => {}}>
      <LabsSettingsPanel />
    </SettingsScopeProvider>,
    { router: "/settings/labs" },
  );

  const boringSidebar = screen.getByRole("switch", { name: "Boring sidebar (group by project)" });
  expect(isInert(boringSidebar.element())).toBe(false);
  await userEvent.click(boringSidebar);
  await expect.element(screen.getByRole("switch", { name: "Two-line folder rows" })).toBeVisible();
  expect(getClientSettings().boringSidebarEnabled).toBe(true);

  const multilineRows = screen.getByRole("switch", { name: "Two-line folder rows" });
  expect(isInert(multilineRows.element())).toBe(false);
  await userEvent.click(multilineRows);
  expect(getClientSettings().boringSidebarMultilineRows).toBe(true);
});
