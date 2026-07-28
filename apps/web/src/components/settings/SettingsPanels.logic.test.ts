import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildProviderInstanceUpdatePatch,
  formatDiagnosticsDescription,
  isProjectGroupingEnabled,
  projectGroupingModeFromToggle,
} from "./SettingsPanels.logic";
import { SETTINGS_NAV_ITEMS } from "./SettingsSidebarNav";

describe("settings navigation", () => {
  it("gives Hermes configuration one distinct T3 Work section", () => {
    expect(SETTINGS_NAV_ITEMS.filter((item) => item.label === "T3 Work")).toHaveLength(1);
    expect(SETTINGS_NAV_ITEMS.some((item) => item.label === "Hermes Cron")).toBe(false);
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

  it("updates the Hermes rollout gate together with the instance enabled state", () => {
    const instanceId = ProviderInstanceId.make("hermes");
    const enabledInstance = {
      driver: ProviderDriverKind.make("hermes"),
      enabled: true,
      config: {
        endpoint: "ws://127.0.0.1:9119/api/ws",
        profileKey: "default",
      },
    } satisfies ProviderInstanceConfig;

    const enabledPatch = buildProviderInstanceUpdatePatch({
      settings: DEFAULT_SERVER_SETTINGS,
      instanceId,
      instance: enabledInstance,
      driver: ProviderDriverKind.make("hermes"),
      isDefault: true,
    });
    expect(enabledPatch.enableHermes).toBe(true);
    expect(enabledPatch.providerInstances?.[instanceId]?.enabled).toBe(true);

    const disabledPatch = buildProviderInstanceUpdatePatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        enableHermes: true,
        providerInstances: enabledPatch.providerInstances!,
      },
      instanceId,
      instance: { ...enabledInstance, enabled: false },
      driver: ProviderDriverKind.make("hermes"),
      isDefault: true,
    });
    expect(disabledPatch.enableHermes).toBe(false);
    expect(disabledPatch.providerInstances?.[instanceId]?.enabled).toBe(false);
  });

  it("keeps the Hermes rollout gate on while another Hermes instance remains enabled", () => {
    const instanceId = ProviderInstanceId.make("hermes");
    const otherId = ProviderInstanceId.make("hermes_work");
    const disabledPatch = buildProviderInstanceUpdatePatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        enableHermes: true,
        providerInstances: {
          [otherId]: {
            driver: ProviderDriverKind.make("hermes"),
            enabled: true,
          },
        },
      },
      instanceId,
      instance: {
        driver: ProviderDriverKind.make("hermes"),
        enabled: false,
      },
      driver: ProviderDriverKind.make("hermes"),
      isDefault: true,
    });

    expect(disabledPatch.enableHermes).toBe(true);
  });
});
