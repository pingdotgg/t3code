import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  SecretProviderKind,
  ServerSettings,
  ServerSettingsPatch,
  UsageLimitSourceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { resolveServerBackgroundActivitySettings } from "./backgroundActivitySettings.ts";
import { createModelSelection } from "./model.ts";
import { resolveProjectScripts } from "./projectScripts.ts";
import {
  applyServerSettingsPatch,
  fallbackTextGenerationModelSelection,
  modelPreferencesMigrationPatch,
  resolveModelPreferences,
  isModelSelectionProviderEnabled,
  parsePersistedServerObservabilitySettings,
  resolveSourceControlWriterModelSelection,
} from "./serverSettings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

const FOLDED_SERVER_SETTINGS = { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: true };






describe("serverSettings helpers", () => {
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
});

