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






describe("fallbackTextGenerationModelSelection", () => {
  it("uses Big Pickle when only OpenCode is enabled", () => {
    expect(
      fallbackTextGenerationModelSelection({}, (instanceId) => instanceId === "opencode"),
    ).toEqual({ instanceId: "opencode", model: "opencode/big-pickle" });
  });

  it("replaces and clears the fallback without carrying model options", () => {
    const fallbackModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "new" };
    const settings = applyServerSettingsPatch(
      {
        ...DEFAULT_SERVER_SETTINGS,
        fallbackModelSelection: {
          ...fallbackModelSelection,
          model: "old",
          options: [{ id: "effort", value: "high" }],
        },
      },
      { fallbackModelSelection },
    );
    expect(settings.fallbackModelSelection).toEqual(fallbackModelSelection);
    expect(
      applyServerSettingsPatch(settings, { fallbackModelSelection: null }).fallbackModelSelection,
    ).toBeNull();
  });
  it("ignores a configured non-default instance at machine scope, matching no fallback", () => {
    const configured = ProviderInstanceId.make("codex_work");
    const providerInstances = {
      [configured]: { driver: ProviderDriverKind.make("codex"), config: {} },
    };
    const fallback = fallbackTextGenerationModelSelection(
      providerInstances,
      (instanceId) => instanceId === configured,
    );
    expect(fallback).toBeNull();
  });

  it("considers a configured non-default instance only when asked to", () => {
    const configured = ProviderInstanceId.make("codex_work");
    const providerInstances = {
      [configured]: { driver: ProviderDriverKind.make("codex"), config: {} },
    };
    const fallback = fallbackTextGenerationModelSelection(
      providerInstances,
      (instanceId) => instanceId === configured,
      { includeConfiguredInstances: true },
    );
    expect(fallback?.instanceId).toBe(configured);
  });
});

