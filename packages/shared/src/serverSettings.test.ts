import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";
import { resolveServerBackgroundActivitySettings } from "./backgroundActivitySettings.ts";
import { createModelSelection } from "./model.ts";
import {
  applyServerSettingsPatch,
  extractPersistedServerObservabilitySettings,
  isModelSelectionProviderEnabled,
  normalizePersistedServerSettingString,
  parsePersistedServerObservabilitySettings,
  resolveSourceControlWriterModelSelection,
} from "./serverSettings.ts";

describe("serverSettings helpers", () => {
  it("normalizes optional persisted strings", () => {
    expect(normalizePersistedServerSettingString(undefined)).toBeUndefined();
    expect(normalizePersistedServerSettingString("   ")).toBeUndefined();
    expect(normalizePersistedServerSettingString("  http://localhost:4318/v1/traces  ")).toBe(
      "http://localhost:4318/v1/traces",
    );
  });

  it("extracts persisted observability settings", () => {
    expect(
      extractPersistedServerObservabilitySettings({
        observability: {
          otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
          otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
        },
      }),
    ).toEqual({
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpMetricsUrl: "http://localhost:4318/v1/metrics",
    });
  });

  it("parses lenient persisted settings JSON", () => {
    expect(
      parsePersistedServerObservabilitySettings(
        JSON.stringify({
          observability: {
            otlpTracesUrl: "http://localhost:4318/v1/traces",
            otlpMetricsUrl: "http://localhost:4318/v1/metrics",
          },
        }),
      ),
    ).toEqual({
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpMetricsUrl: "http://localhost:4318/v1/metrics",
    });
  });

  it("falls back cleanly when persisted settings are invalid", () => {
    expect(parsePersistedServerObservabilitySettings("{")).toEqual({
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
    });
  });

  it("replaces text generation selection when provider/model are provided", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("still deep merges text generation selection when only options are provided", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          options: [{ id: "fastMode", value: false }],
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4-mini",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: false },
      ],
    });
  });

  it("replaces text generation selection across providers without leaking stale options", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
    });
  });

  it("accepts array-based text generation selection patches", () => {
    expect(
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
          options: [
            { id: "variant", value: "prod" },
            { id: "agent", value: "build" },
          ],
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
      options: [
        { id: "variant", value: "prod" },
        { id: "agent", value: "build" },
      ],
    });
  });

  it("replaces source control writer selection without retaining stale options", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      sourceControlWriterModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [{ id: "reasoningEffort", value: "high" }],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        sourceControlWriterModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      }).sourceControlWriterModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
    });
  });

  it("clears source control writer selection with null", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      sourceControlWriterModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        sourceControlWriterModelSelection: null,
      }).sourceControlWriterModelSelection,
    ).toBeNull();
  });

  it("falls back from a disabled source control writer provider without clearing its selection", () => {
    const instanceId = ProviderInstanceId.make("codex_writer");
    const sourceControlWriterModelSelection = createModelSelection(instanceId, "gpt-5.4-mini");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
          config: {},
        },
      },
      sourceControlWriterModelSelection,
    };

    expect(isModelSelectionProviderEnabled(settings, sourceControlWriterModelSelection)).toBe(
      false,
    );
    expect(resolveSourceControlWriterModelSelection(settings)).toBe(
      settings.textGenerationModelSelection,
    );
    expect(settings.sourceControlWriterModelSelection).toBe(sourceControlWriterModelSelection);
  });

  it("falls back from an unavailable source control writer provider", () => {
    const instanceId = ProviderInstanceId.make("missing_writer");
    const sourceControlWriterModelSelection = createModelSelection(instanceId, "missing-model");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("missing-driver"),
          config: {},
        },
      },
      sourceControlWriterModelSelection,
    };
    const unavailableProvider = {
      instanceId,
      driver: ProviderDriverKind.make("missing-driver"),
      enabled: false,
      installed: false,
      version: null,
      status: "disabled",
      auth: { status: "unknown" },
      checkedAt: "2026-07-27T00:00:00.000Z",
      availability: "unavailable",
      unavailableReason: "This provider driver is not available in this build.",
      models: [],
      slashCommands: [],
      skills: [],
    } satisfies ServerProvider;

    expect(resolveSourceControlWriterModelSelection(settings, [unavailableProvider])).toBe(
      settings.textGenerationModelSelection,
    );
    expect(settings.sourceControlWriterModelSelection).toBe(sourceControlWriterModelSelection);
  });

  it("replaces providerInstances maps so omitted instance fields are cleared", () => {
    const codexId = ProviderInstanceId.make("codex");
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Codex Work",
          accentColor: "#7c3aed",
          enabled: true,
          config: { homePath: "~/.codex" },
        },
      },
    };

    expect(
      applyServerSettingsPatch(current, {
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      }).providerInstances[codexId],
    ).toEqual({
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex Work",
      enabled: true,
      config: { homePath: "~/.codex" },
    });
  });

  it("stores background activity profiles as a versioned object and syncs legacy aliases", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivity: {
        schemaVersion: 1,
        profile: "battery-saver",
        overrides: {},
      },
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "battery-saver",
      overrides: {},
    });
    expect(next.backgroundActivityProfile).toBe("battery-saver");
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(0);
    expect(Duration.toMillis(next.providerHealthRefreshInterval)).toBe(
      Duration.toMillis(Duration.minutes(15)),
    );
  });

  it("turns legacy interval patches into custom background activity overrides", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      automaticGitFetchInterval: Duration.seconds(15),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "balanced",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(15),
      },
    });
    expect(resolveServerBackgroundActivitySettings(next).profile).toBe("balanced");
    expect(
      Duration.toMillis(resolveServerBackgroundActivitySettings(next).automaticGitFetchInterval),
    ).toBe(15_000);
  });

  it("preserves legacy background activity settings when applying an unrelated patch", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      backgroundActivityProfile: "performance" as const,
      automaticGitFetchInterval: Duration.seconds(7),
      providerHealthRefreshInterval: Duration.minutes(4),
    };

    const next = applyServerSettingsPatch(current, {
      sourceControlWriterModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
      ),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(7),
        providerHealthRefreshInterval: Duration.minutes(4),
      },
    });
    expect(next.backgroundActivityProfile).toBe("performance");
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(7_000);
    expect(Duration.toMillis(next.providerHealthRefreshInterval)).toBe(240_000);
  });

  it("does not reactivate dormant overrides from a concrete profile", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      backgroundActivity: {
        schemaVersion: 1 as const,
        profile: "battery-saver" as const,
        overrides: {
          providerHealthRefreshInterval: Duration.seconds(5),
        },
      },
    };

    const next = applyServerSettingsPatch(current, {
      automaticGitFetchInterval: Duration.seconds(15),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "battery-saver",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(15),
      },
    });
  });

  it("prefers structured background activity settings over legacy aliases", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivity: {
        schemaVersion: 1,
        profile: "battery-saver",
        overrides: {},
      },
      automaticGitFetchInterval: Duration.seconds(5),
      backgroundActivityProfile: "performance",
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "battery-saver",
      overrides: {},
    });
    expect(next.backgroundActivityProfile).toBe("battery-saver");
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(0);
  });

  it("reconciles custom background activity back to a preset when overrides match the preset", () => {
    const custom = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      automaticGitFetchInterval: Duration.seconds(15),
    });
    const next = applyServerSettingsPatch(custom, {
      automaticGitFetchInterval: Duration.seconds(30),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "balanced",
      overrides: {},
    });
    expect(next.backgroundActivityProfile).toBe("balanced");
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(30_000);
  });

  it("drops custom overrides that duplicate the base profile", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivity: {
        schemaVersion: 1,
        profile: "custom",
        baseProfile: "balanced",
        overrides: {
          automaticGitFetchInterval: Duration.seconds(30),
        },
      },
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "balanced",
      overrides: {},
    });
  });

  it("replaces the complete background override record", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivity: {
        schemaVersion: 1,
        profile: "custom",
        baseProfile: "balanced",
        overrides: {
          automaticGitFetchInterval: Duration.seconds(15),
          providerHealthRefreshInterval: Duration.minutes(3),
        },
      },
    });

    const next = applyServerSettingsPatch(current, {
      backgroundActivity: {
        overrides: {
          automaticGitFetchInterval: Duration.seconds(10),
        },
      },
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "balanced",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(10),
      },
    });
  });

  it("keeps interval overrides supplied with a profile patch", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivityProfile: "performance",
      automaticGitFetchInterval: Duration.seconds(0),
      providerHealthRefreshInterval: Duration.minutes(4),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(0),
        providerHealthRefreshInterval: Duration.minutes(4),
      },
    });
  });

  it("ignores overrides attached to a concrete background profile", () => {
    const resolved = resolveServerBackgroundActivitySettings({
      ...DEFAULT_SERVER_SETTINGS,
      backgroundActivity: {
        schemaVersion: 1,
        profile: "balanced",
        overrides: {
          pauseWhenOnBattery: true,
        },
      },
    });

    expect(resolved.pauseWhenOnBattery).toBe(false);
  });
});
