import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildGeneralSettingsRestorePatch,
  buildProviderInstanceUpdatePatch,
  formatDiagnosticsDescription,
  hasChangedGeneralServerSettings,
  isProjectGroupingEnabled,
  projectGroupingModeFromToggle,
  resolveSettingsEnvironmentId,
} from "./SettingsPanels.logic";
import * as Duration from "effect/Duration";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("00000000-0000-4000-8000-000000000001");
const REMOTE_ENVIRONMENT_ID = EnvironmentId.make("00000000-0000-4000-8000-000000000002");

describe("settings environment selection", () => {
  it("preserves an explicit selected environment", () => {
    expect(
      resolveSettingsEnvironmentId({
        availableEnvironmentIds: [LOCAL_ENVIRONMENT_ID, REMOTE_ENVIRONMENT_ID],
        selectedEnvironmentId: REMOTE_ENVIRONMENT_ID,
        primaryEnvironmentId: LOCAL_ENVIRONMENT_ID,
        activeEnvironmentId: LOCAL_ENVIRONMENT_ID,
      }),
    ).toBe(REMOTE_ENVIRONMENT_ID);
  });

  it("defaults to the primary environment in managed mode", () => {
    expect(
      resolveSettingsEnvironmentId({
        availableEnvironmentIds: [REMOTE_ENVIRONMENT_ID, LOCAL_ENVIRONMENT_ID],
        selectedEnvironmentId: null,
        primaryEnvironmentId: LOCAL_ENVIRONMENT_ID,
        activeEnvironmentId: REMOTE_ENVIRONMENT_ID,
      }),
    ).toBe(LOCAL_ENVIRONMENT_ID);
  });

  it("defaults to the active remote environment in client-only mode", () => {
    expect(
      resolveSettingsEnvironmentId({
        availableEnvironmentIds: [LOCAL_ENVIRONMENT_ID, REMOTE_ENVIRONMENT_ID],
        selectedEnvironmentId: null,
        primaryEnvironmentId: null,
        activeEnvironmentId: REMOTE_ENVIRONMENT_ID,
      }),
    ).toBe(REMOTE_ENVIRONMENT_ID);
  });

  it("falls back when the selected environment is no longer available", () => {
    expect(
      resolveSettingsEnvironmentId({
        availableEnvironmentIds: [LOCAL_ENVIRONMENT_ID],
        selectedEnvironmentId: REMOTE_ENVIRONMENT_ID,
        primaryEnvironmentId: LOCAL_ENVIRONMENT_ID,
        activeEnvironmentId: REMOTE_ENVIRONMENT_ID,
      }),
    ).toBe(LOCAL_ENVIRONMENT_ID);
  });

  it("uses the first saved environment when client-only mode has no active environment yet", () => {
    expect(
      resolveSettingsEnvironmentId({
        availableEnvironmentIds: [REMOTE_ENVIRONMENT_ID, LOCAL_ENVIRONMENT_ID],
        selectedEnvironmentId: null,
        primaryEnvironmentId: null,
        activeEnvironmentId: null,
      }),
    ).toBe(REMOTE_ENVIRONMENT_ID);
  });

  it("returns null when no environments are available", () => {
    expect(
      resolveSettingsEnvironmentId({
        availableEnvironmentIds: [],
        selectedEnvironmentId: null,
        primaryEnvironmentId: null,
        activeEnvironmentId: null,
      }),
    ).toBeNull();
  });
});

describe("general settings restore", () => {
  it("detects whether server-backed general settings differ from their defaults", () => {
    expect(hasChangedGeneralServerSettings(DEFAULT_SERVER_SETTINGS)).toBe(false);
    expect(
      hasChangedGeneralServerSettings({
        ...DEFAULT_SERVER_SETTINGS,
        automaticGitFetchInterval: Duration.seconds(5),
      }),
    ).toBe(true);
  });

  it("omits server-backed defaults when only client settings need restoring", () => {
    const clientOnlyPatch = buildGeneralSettingsRestorePatch({
      includeServerSettings: false,
    });
    const serverAndClientPatch = buildGeneralSettingsRestorePatch({
      includeServerSettings: true,
    });

    expect(clientOnlyPatch).toHaveProperty("wordWrap");
    expect(clientOnlyPatch).not.toHaveProperty("enableAssistantStreaming");
    expect(clientOnlyPatch).not.toHaveProperty("textGenerationModelSelection");
    expect(serverAndClientPatch).toHaveProperty("enableAssistantStreaming");
    expect(serverAndClientPatch).toHaveProperty("textGenerationModelSelection");
  });
});

describe("project grouping toggle", () => {
  it("enables repository grouping and disables into separate projects", () => {
    expect(isProjectGroupingEnabled("repository")).toBe(true);
    expect(isProjectGroupingEnabled("repository_path")).toBe(true);
    expect(isProjectGroupingEnabled("separate")).toBe(false);
    expect(projectGroupingModeFromToggle(true)).toBe("repository");
    expect(projectGroupingModeFromToggle(false)).toBe("separate");
  });

  it("restores repository path grouping when the toggle is cycled", () => {
    expect(projectGroupingModeFromToggle(false, "repository_path")).toBe("separate");
    expect(projectGroupingModeFromToggle(true, "repository_path")).toBe("repository_path");
  });
});

describe("formatDiagnosticsDescription", () => {
  it("collapses trace and metric URLs that share the same OTEL base path", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      }),
    ).toBe("Local trace file. Exporting OTEL to http://localhost:4318/v1/{traces,metrics}.");
  });

  it("keeps separate trace and metric URLs when their base paths differ", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:9000/v1/metrics",
      }),
    ).toBe(
      "Local trace file. Exporting OTEL traces to http://localhost:4318/v1/traces and metrics to http://localhost:9000/v1/metrics.",
    );
  });

  it("omits OTEL text when no exporter is enabled", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      }),
    ).toBe("Local trace file.");
  });
});

describe("buildProviderInstanceUpdatePatch", () => {
  it("promotes an edited default provider into providerInstances and resets the legacy provider", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        binaryPath: "/opt/t3/codex",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            binaryPath: "/legacy/codex",
          },
        },
      },
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: true,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers?.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
  });

  it("updates custom instances without touching legacy provider settings", () => {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        homePath: "/Users/example/.codex-personal",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: DEFAULT_SERVER_SETTINGS,
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: false,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers).toBeUndefined();
  });
});
