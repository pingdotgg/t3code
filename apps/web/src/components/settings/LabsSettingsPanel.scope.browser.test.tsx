import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ProjectId, ServerConfig } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import "../../index.css";
import { ensureClientSettingsHydrated, persistClientSettingsPatch } from "../../hooks/useSettings";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { EnvironmentPresentation } from "../../state/environments";
import type { Project } from "../../types";

const environmentId = EnvironmentId.make("labs-settings");
const decodeServerConfig = Schema.decodeSync(ServerConfig);
function makeConfig(overrides?: {
  readonly agentFeedback?: boolean;
  readonly agentFeedbackMode?: "off" | "on-request" | "auto";
  readonly telemetryEnabled?: boolean;
}) {
  return decodeServerConfig({
    environment: {
      environmentId,
      label: "Desk",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "1.0.0",
      orchestrationProtocolVersion: 2,
      capabilities:
        overrides?.agentFeedback === undefined ? {} : { agentFeedback: overrides.agentFeedback },
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
      ...(overrides?.telemetryEnabled === undefined
        ? {}
        : { telemetryEnabled: overrides.telemetryEnabled }),
    },
    settings:
      overrides?.agentFeedbackMode === undefined
        ? {}
        : { agentFeedback: { mode: overrides.agentFeedbackMode } },
  });
}

let currentConfig = makeConfig();
const makeEnvironments = (): EnvironmentPresentation[] => [
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
    serverConfig: currentConfig,
  },
];
let environments: EnvironmentPresentation[] = makeEnvironments();
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
  useServerConfigs: () => new Map([[environmentId, currentConfig]]),
}));

import { LabsSettingsPanel } from "./LabsSettingsPanel";
import { SettingsScopeProvider } from "./SettingsScopeContext";

const [group] = buildSidebarProjectSnapshots({
  projects,
  settings: DEFAULT_CLIENT_SETTINGS,
  primaryEnvironmentId: environmentId,
  resolveEnvironmentLabel: () => "Desk",
});

it("shows Boring sidebar device preferences read-only while a project is selected", async () => {
  await ensureClientSettingsHydrated();
  await persistClientSettingsPatch(
    { boringSidebarEnabled: true, boringSidebarMultilineRows: false },
    async () => {},
  );
  await using screen = await render(
    <SettingsScopeProvider search={{ project: group!.projectKey }} onChange={() => {}}>
      <LabsSettingsPanel />
    </SettingsScopeProvider>,
    { router: "/settings/labs" },
  );

  for (const name of ["Boring sidebar (group by project)", "Two-line folder rows"]) {
    expect(screen.getByRole("switch", { name }).element().closest("[inert]")).not.toBeNull();
  }
});

it("warns in Agent feedback when telemetry is off on the machine", async () => {
  await ensureClientSettingsHydrated();
  currentConfig = makeConfig({
    agentFeedback: true,
    agentFeedbackMode: "on-request",
    telemetryEnabled: false,
  });
  environments = makeEnvironments();
  await using screen = await render(
    <SettingsScopeProvider search={{}} onChange={() => {}}>
      <LabsSettingsPanel />
    </SettingsScopeProvider>,
    { router: "/settings/labs" },
  );

  await expect
    .element(
      screen.getByText(
        "Telemetry is off on this machine, so reports stay local and cannot be sent to the T3 team.",
      ),
    )
    .toBeVisible();

  currentConfig = makeConfig({
    agentFeedback: true,
    agentFeedbackMode: "off",
    telemetryEnabled: false,
  });
  environments = makeEnvironments();
  await using offScreen = await render(
    <SettingsScopeProvider search={{}} onChange={() => {}}>
      <LabsSettingsPanel />
    </SettingsScopeProvider>,
    { router: "/settings/labs" },
  );

  await expect
    .element(
      offScreen.getByText(
        "Telemetry is off on this machine, so reports stay local and cannot be sent to the T3 team.",
      ),
    )
    .not.toBeInTheDocument();
});
