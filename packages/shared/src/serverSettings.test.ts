import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";
import { resolveServerBackgroundActivitySettings } from "./backgroundActivitySettings.ts";
import { createModelSelection } from "./model.ts";
import { resolveProjectScripts, projectScriptsInheritDefaults } from "./projectScripts.ts";
import {
  applyServerSettingsPatch,
  isModelSelectionProviderEnabled,
  parsePersistedServerObservabilitySettings,
  resolveSourceControlWriterModelSelection,
  resolveProjectAgentBrowserAccess,
  resolveProjectAutoPull,
} from "./serverSettings.ts";

describe("serverSettings helpers", () => {
  it("inherits actions, preserves existing actions, and supports empty overrides and reset", () => {
    const project = { id: ProjectId.make("project-actions"), scripts: [] };
    const action = {
      id: "check",
      name: "Check",
      command: "npm test",
      icon: "play" as const,
      runOnWorktreeCreate: false,
    };
    const defaults = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultProjectScripts: [action],
    });
    expect(resolveProjectScripts(defaults, project)).toEqual([action]);
    expect(projectScriptsInheritDefaults(defaults, project)).toBe(true);
    const existing = { ...project, scripts: [{ ...action, command: "npm run lint" }] };
    expect(resolveProjectScripts(defaults, existing)).toEqual(existing.scripts);
    expect(projectScriptsInheritDefaults(defaults, existing)).toBe(false);
    const disabled = applyServerSettingsPatch(defaults, {
      projectScriptOverrides: { [project.id]: [] },
    });
    expect(resolveProjectScripts(disabled, project)).toEqual([]);
    expect(projectScriptsInheritDefaults(disabled, project)).toBe(false);
    const changedDefault = applyServerSettingsPatch(disabled, {
      defaultProjectScripts: [{ ...action, command: "npm run build" }],
    });
    expect(resolveProjectScripts(changedDefault, project)).toEqual([]);
    const reset = applyServerSettingsPatch(changedDefault, {
      projectScriptOverrides: { [project.id]: null },
    });
    expect(resolveProjectScripts(reset, existing)).toEqual(changedDefault.defaultProjectScripts);
    expect(projectScriptsInheritDefaults(reset, existing)).toBe(true);
    expect(
      resolveProjectScripts(
        applyServerSettingsPatch(reset, { defaultProjectScripts: [] }),
        existing,
      ),
    ).toEqual([]);
  });

  it("preserves other projects' actions when overriding, clearing, or resetting one project", () => {
    const firstProject = { id: ProjectId.make("first-project"), scripts: [] };
    const secondProject = { id: ProjectId.make("second-project"), scripts: [] };
    const defaultAction = {
      id: "check",
      name: "Check",
      command: "npm test",
      icon: "play" as const,
      runOnWorktreeCreate: false,
    };
    const firstAction = { ...defaultAction, command: "npm run lint" };
    const secondAction = { ...defaultAction, command: "npm run build" };
    const firstUpdate = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultProjectScripts: [defaultAction],
      projectScriptOverrides: { [firstProject.id]: [firstAction] },
    });
    const secondUpdate = applyServerSettingsPatch(firstUpdate, {
      projectScriptOverrides: { [secondProject.id]: [secondAction] },
    });
    expect(resolveProjectScripts(secondUpdate, firstProject)).toEqual([firstAction]);
    expect(resolveProjectScripts(secondUpdate, secondProject)).toEqual([secondAction]);

    const cleared = applyServerSettingsPatch(secondUpdate, {
      projectScriptOverrides: { [firstProject.id]: [] },
    });
    expect(resolveProjectScripts(cleared, firstProject)).toEqual([]);
    expect(resolveProjectScripts(cleared, secondProject)).toEqual([secondAction]);

    const reset = applyServerSettingsPatch(cleared, {
      projectScriptOverrides: { [firstProject.id]: null },
    });
    expect(resolveProjectScripts(reset, { ...firstProject, scripts: [firstAction] })).toEqual([
      defaultAction,
    ]);
    expect(resolveProjectScripts(reset, secondProject)).toEqual([secondAction]);
    expect(resolveProjectScripts(secondUpdate, firstProject)).toEqual([firstAction]);
  });

  it("inherits automatic pull while preserving legacy opt-ins and explicit overrides", () => {
    const projectId = ProjectId.make("project-pull");
    expect(resolveProjectAutoPull(DEFAULT_SERVER_SETTINGS, projectId, false)).toBe(false);
    expect(resolveProjectAutoPull(DEFAULT_SERVER_SETTINGS, projectId, true)).toBe(true);
    const enabled = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { defaultAutoPull: true });
    expect(resolveProjectAutoPull(enabled, projectId, false)).toBe(true);
    const overridden = applyServerSettingsPatch(enabled, {
      projectAutoPullOverrides: { [projectId]: false },
    });
    expect(resolveProjectAutoPull(overridden, projectId, true)).toBe(false);
    const reset = applyServerSettingsPatch(overridden, {
      projectAutoPullOverrides: { [projectId]: null },
    });
    expect(resolveProjectAutoPull(reset, projectId, false)).toBe(true);
    const disabled = applyServerSettingsPatch(reset, {
      defaultAutoPull: false,
      projectAutoPullOverrides: { [projectId]: true },
    });
    expect(resolveProjectAutoPull(disabled, projectId, false)).toBe(true);
    expect(resolveProjectAutoPull(disabled, ProjectId.make("other-project"), false)).toBe(false);
  });

  it("inherits browser access and restores inheritance when a project override is removed", () => {
    const projectId = ProjectId.make("project-browser");
    const otherProjectId = ProjectId.make("other-project");
    const overridden = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectAgentBrowserAccessOverrides: { [projectId]: false },
    });
    expect(resolveProjectAgentBrowserAccess(overridden, projectId)).toBe(false);
    expect(resolveProjectAgentBrowserAccess(overridden, otherProjectId)).toBe(true);
    const reset = applyServerSettingsPatch(overridden, {
      projectAgentBrowserAccessOverrides: { [projectId]: null },
    });
    expect(resolveProjectAgentBrowserAccess(reset, projectId)).toBe(true);
    const enabled = applyServerSettingsPatch(reset, {
      enableAgentBrowserAccess: false,
      projectAgentBrowserAccessOverrides: { [projectId]: true },
    });
    expect(resolveProjectAgentBrowserAccess(enabled, projectId)).toBe(true);
    expect(resolveProjectAgentBrowserAccess(enabled, otherProjectId)).toBe(false);
  });

  it("preserves other projects' boolean overrides across separate updates and resets", () => {
    const firstProjectId = ProjectId.make("first-project");
    const secondProjectId = ProjectId.make("second-project");
    const firstUpdate = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultAutoPull: true,
      projectAutoPullOverrides: { [firstProjectId]: false },
      projectAgentBrowserAccessOverrides: { [firstProjectId]: false },
    });
    const secondUpdate = applyServerSettingsPatch(firstUpdate, {
      projectAutoPullOverrides: { [secondProjectId]: false },
      projectAgentBrowserAccessOverrides: { [secondProjectId]: false },
    });
    for (const projectId of [firstProjectId, secondProjectId]) {
      expect(resolveProjectAutoPull(secondUpdate, projectId, false)).toBe(false);
      expect(resolveProjectAgentBrowserAccess(secondUpdate, projectId)).toBe(false);
    }

    const reset = applyServerSettingsPatch(secondUpdate, {
      projectAutoPullOverrides: { [firstProjectId]: null },
      projectAgentBrowserAccessOverrides: { [firstProjectId]: null },
    });
    expect(resolveProjectAutoPull(reset, firstProjectId, false)).toBe(true);
    expect(resolveProjectAgentBrowserAccess(reset, firstProjectId)).toBe(true);
    expect(resolveProjectAutoPull(reset, secondProjectId, false)).toBe(false);
    expect(resolveProjectAgentBrowserAccess(reset, secondProjectId)).toBe(false);
    expect(reset.projectAutoPullOverrides[firstProjectId]).toBeUndefined();
    expect(reset.projectAgentBrowserAccessOverrides[firstProjectId]).toBeUndefined();
    expect(resolveProjectAutoPull(secondUpdate, firstProjectId, false)).toBe(false);
    expect(resolveProjectAgentBrowserAccess(secondUpdate, firstProjectId)).toBe(false);
  });

  it("replaces and clears conversation model defaults without retaining old options", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultModelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
      ]),
    });
    const selection = createModelSelection(ProviderInstanceId.make("claudeAgent"), "sonnet");
    const updated = applyServerSettingsPatch(current, { defaultModelSelection: selection });
    expect(updated.defaultModelSelection).toEqual(selection);
    expect(
      applyServerSettingsPatch(updated, { defaultModelSelection: null }).defaultModelSelection,
    ).toBeNull();
  });

  it("ignores missing and blank persisted observability URLs", () => {
    expect(parsePersistedServerObservabilitySettings("{}")).toEqual({
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
    });
    expect(
      parsePersistedServerObservabilitySettings(
        JSON.stringify({ observability: { otlpTracesUrl: "   ", otlpMetricsUrl: "" } }),
      ),
    ).toEqual({
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
    });
  });

  it("parses lenient persisted settings JSON and trims observability URLs", () => {
    expect(
      parsePersistedServerObservabilitySettings(
        JSON.stringify({
          observability: {
            otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
            otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
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

  it("upserts and removes usageLimitSources per entry so concurrent edits cannot clobber", () => {
    const hubA = UsageLimitSourceId.make("cliproxy-a");
    const hubB = UsageLimitSourceId.make("cliproxy-b");
    const source = (url: string) => ({
      kind: "cliproxy" as const,
      url,
      managementKey: "secret",
      enabled: true,
    });
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      usageLimitSources: { [hubA]: source("http://a:8318") },
    };

    const added = applyServerSettingsPatch(current, {
      usageLimitSources: { [hubB]: source("http://b:8318") },
    });
    expect(Object.keys(added.usageLimitSources)).toEqual([hubA, hubB]);

    const removed = applyServerSettingsPatch(added, { usageLimitSources: { [hubA]: null } });
    expect(Object.keys(removed.usageLimitSources)).toEqual([hubB]);
  });

  it("replaces and removes individual usage prices without clobbering other models", () => {
    const prices = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      usagePriceOverrides: { "example-model": { ...prices, cacheReadCostPerMillionTokens: 0.5 } },
    });
    const added = applyServerSettingsPatch(current, {
      usagePriceOverrides: { "other-model": prices },
    });
    const replaced = applyServerSettingsPatch(added, {
      usagePriceOverrides: { "example-model": prices },
    });
    expect(replaced.usagePriceOverrides).toEqual({
      "example-model": prices,
      "other-model": prices,
    });
    const removed = applyServerSettingsPatch(replaced, {
      usagePriceOverrides: { "example-model": null },
    });
    expect(removed.usagePriceOverrides).toEqual({ "other-model": prices });
    expect(current.usagePriceOverrides["example-model"]?.cacheReadCostPerMillionTokens).toBe(0.5);
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
