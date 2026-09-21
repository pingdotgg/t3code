import {
  DEFAULT_SERVER_SETTINGS,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection } from "./model.ts";
import {
  clearProjectSettingsOverrides,
  hasProjectSettingsOverrides,
  resolveProjectSettings,
  resolveWorktreeCleanup,
  withProjectSettingsOverrides,
} from "./projectSettings.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const projectId = ProjectId.make("project-a");
const otherProjectId = ProjectId.make("project-b");

describe("resolveProjectSettings", () => {
  it("inherits every scopable key when the project has no overrides", () => {
    const resolved = resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId);
    expect(resolved.settings).toBe(DEFAULT_SERVER_SETTINGS);
    for (const key of PROJECT_SCOPED_SERVER_SETTING_KEYS) {
      expect(resolved.sources[key]).toBe("environment");
    }
    expect(resolveProjectSettings(DEFAULT_SERVER_SETTINGS, null).settings).toBe(
      DEFAULT_SERVER_SETTINGS,
    );
  });

  it("treats a null project like an absent one before the shell snapshot arrives", () => {
    // The mobile new-task flow resolves settings while its selected project is
    // still null; reading the aggregate's legacy fields off null crashed launch.
    expect(resolveProjectSettings(DEFAULT_SERVER_SETTINGS, null, null).settings).toBe(
      DEFAULT_SERVER_SETTINGS,
    );
  });

  it("applies overrides per key and reports their source", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultAutoPull: true,
      sidebarAutoSettleAfterDays: 3,
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: false, sidebarAutoSettleAfterDays: null },
      },
    });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.defaultAutoPull).toBe(false);
    expect(resolved.settings.sidebarAutoSettleAfterDays).toBeNull();
    expect(resolved.settings.defaultThreadEnvMode).toBe(settings.defaultThreadEnvMode);
    expect(resolved.sources.defaultAutoPull).toBe("project");
    expect(resolved.sources.sidebarAutoSettleAfterDays).toBe("project");
    expect(resolved.sources.defaultThreadEnvMode).toBe("environment");
    expect(resolveProjectSettings(settings, otherProjectId).settings.defaultAutoPull).toBe(true);
  });

  it("keeps the environment text generation model when the override's provider is disabled", () => {
    const disabledSelection = createModelSelection(ProviderInstanceId.make("claudeAgent"), "opus");
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providers: { claudeAgent: { enabled: false } },
      projectSettingsOverrides: {
        [projectId]: { textGenerationModelSelection: disabledSelection },
      },
    });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.textGenerationModelSelection).toEqual(
      settings.textGenerationModelSelection,
    );
    expect(resolved.sources.textGenerationModelSelection).toBe("environment");
  });

  it("honours the aggregate's own fields only until the server has folded them", () => {
    const aggregateModel = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5");
    const project = {
      defaultModelSelection: aggregateModel,
      defaultThreadEnvMode: "local" as const,
    };
    const unfolded = resolveProjectSettings(
      { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: false },
      projectId,
      project,
    );
    expect(unfolded.settings.defaultModelSelection).toEqual(aggregateModel);
    expect(unfolded.settings.defaultThreadEnvMode).toBe("local");
    expect(unfolded.sources.defaultModelSelection).toBe("project");
    // A stored override still beats the aggregate before the fold.
    const overridden = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsFolded: false,
        projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "worktree" } },
      },
      projectId,
      project,
    );
    expect(overridden.settings.defaultThreadEnvMode).toBe("worktree");
    // After the fold a reset in the record wins over the stale aggregate.
    const folded = resolveProjectSettings(
      { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: true },
      projectId,
      project,
    );
    expect(folded.settings.defaultModelSelection).toBeNull();
    expect(folded.sources.defaultModelSelection).toBe("environment");
  });

  it("keeps the environment default model when the override's provider is disabled", () => {
    const disabledSelection = createModelSelection(ProviderInstanceId.make("claudeAgent"), "opus");
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providers: { claudeAgent: { enabled: false } },
      projectSettingsOverrides: { [projectId]: { defaultModelSelection: disabledSelection } },
    });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.defaultModelSelection).toBeNull();
    expect(resolved.sources.defaultModelSelection).toBe("environment");
  });
});

describe("resolveProjectSettings with a t3.json", () => {
  it("walks project override, environment value, file, then built-in for file-backed keys", () => {
    const file = { defaultThreadEnvMode: "worktree" as const };
    const fromOverride = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "local" } },
      },
      projectId,
      null,
      file,
    );
    expect(fromOverride.settings.defaultThreadEnvMode).toBe("local");
    expect(fromOverride.sources.defaultThreadEnvMode).toBe("project");

    const fromEnvironment = resolveProjectSettings(
      { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "local" },
      projectId,
      null,
      file,
    );
    expect(fromEnvironment.settings.defaultThreadEnvMode).toBe("local");
    expect(fromEnvironment.sources.defaultThreadEnvMode).toBe("environment");

    const fromFile = resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, file);
    expect(fromFile.settings.defaultThreadEnvMode).toBe("worktree");
    expect(fromFile.sources.defaultThreadEnvMode).toBe("t3.json");

    const builtIn = resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, null);
    expect(builtIn.settings.defaultThreadEnvMode).toBe("local");
    expect(builtIn.sources.defaultThreadEnvMode).toBe("environment");
    // A file that does not mention the key leaves the source alone too.
    expect(
      resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, {}).sources
        .defaultThreadEnvMode,
    ).toBe("environment");
  });

  it("leaves settings untouched when no file is passed", () => {
    expect(resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId).settings).toBe(
      DEFAULT_SERVER_SETTINGS,
    );
  });
});

describe("projectSettingsOverrides patches", () => {
  it("replaces a project's entry, removes it with null, and drops empty entries", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: true, enableAgentBrowserAccess: false },
        [otherProjectId]: { defaultAutoPull: false },
      },
    });
    expect(hasProjectSettingsOverrides(first)).toBe(true);
    const replaced = applyServerSettingsPatch(first, {
      projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: false } },
    });
    expect(replaced.projectSettingsOverrides[projectId]).toEqual({
      enableAgentBrowserAccess: false,
    });
    expect(replaced.projectSettingsOverrides[otherProjectId]).toEqual({ defaultAutoPull: false });
    const emptied = applyServerSettingsPatch(replaced, {
      projectSettingsOverrides: { [projectId]: {} },
    });
    expect(emptied.projectSettingsOverrides[projectId]).toBeUndefined();
    const removed = applyServerSettingsPatch(replaced, {
      projectSettingsOverrides: { [projectId]: null },
    });
    expect(removed.projectSettingsOverrides).toEqual({
      [otherProjectId]: { defaultAutoPull: false },
    });
    expect(hasProjectSettingsOverrides(DEFAULT_SERVER_SETTINGS)).toBe(false);
  });

  it("derives the legacy per-key maps from the generic record", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: true, enableAgentBrowserAccess: false },
        [otherProjectId]: { defaultProjectScripts: [] },
      },
    });
    expect(settings.projectAutoPullOverrides).toEqual({ [projectId]: true });
    expect(settings.projectAgentBrowserAccessOverrides).toEqual({ [projectId]: false });
    expect(settings.projectScriptOverrides).toEqual({ [otherProjectId]: [] });
  });

  it("translates legacy per-key patches into the generic record", () => {
    const written = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectAutoPullOverrides: { [projectId]: true },
      projectAgentBrowserAccessOverrides: { [projectId]: false, [otherProjectId]: true },
    });
    expect(written.projectSettingsOverrides).toEqual({
      [projectId]: { defaultAutoPull: true, enableAgentBrowserAccess: false },
      [otherProjectId]: { enableAgentBrowserAccess: true },
    });
    const cleared = applyServerSettingsPatch(written, {
      projectAgentBrowserAccessOverrides: { [projectId]: null, [otherProjectId]: null },
    });
    expect(cleared.projectSettingsOverrides).toEqual({ [projectId]: { defaultAutoPull: true } });
  });

  it("lets a canonical entry win over a legacy map for the same project", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
    });
    // The canonical entry omits defaultAutoPull to clear it; the stale legacy
    // map in the same patch must not put it back.
    const next = applyServerSettingsPatch(current, {
      projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "local" } },
      projectAutoPullOverrides: { [projectId]: true, [otherProjectId]: false },
    });
    expect(next.projectSettingsOverrides).toEqual({
      [projectId]: { defaultThreadEnvMode: "local" },
      [otherProjectId]: { defaultAutoPull: false },
    });
  });

  it("builds replacement entries and clears individual keys", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: true, enableAgentBrowserAccess: false },
      },
    });
    expect(clearProjectSettingsOverrides(settings, projectId, ["defaultAutoPull"])).toEqual({
      enableAgentBrowserAccess: false,
    });
    expect(
      clearProjectSettingsOverrides(settings, projectId, [
        "defaultAutoPull",
        "enableAgentBrowserAccess",
      ]),
    ).toBeNull();
    expect(clearProjectSettingsOverrides(settings, otherProjectId, ["defaultAutoPull"])).toBeNull();
    expect(withProjectSettingsOverrides(settings, projectId, null)).toEqual({});
    expect(
      withProjectSettingsOverrides(settings, otherProjectId, { defaultThreadEnvMode: "worktree" }),
    ).toEqual({
      ...settings.projectSettingsOverrides,
      [otherProjectId]: { defaultThreadEnvMode: "worktree" },
    });
  });
});

describe("resolveWorktreeCleanup", () => {
  it("inherits machine rules, disables one project and keeps custom rules isolated", () => {
    const machine = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      storageCleanup: { worktreeAfterDays: 8, worktreeOnDelete: true, logsAfterDays: 3 },
    });
    const inherited = resolveWorktreeCleanup(machine, projectId);
    const off = applyServerSettingsPatch(machine, {
      projectSettingsOverrides: {
        [projectId]: { worktreeCleanup: { mode: "off" } },
      },
    });
    expect(resolveWorktreeCleanup(off, projectId)).toEqual({
      worktreeAfterDays: null,
      worktreeOnDelete: false,
      worktreeOnMerge: false,
      worktreeUnchanged: false,
    });
    expect(resolveWorktreeCleanup(off, otherProjectId)).toEqual(inherited);
    const custom = applyServerSettingsPatch(off, {
      projectSettingsOverrides: {
        [projectId]: {
          worktreeCleanup: { mode: "custom", rules: { ...inherited, worktreeAfterDays: 15 } },
        },
      },
    });
    expect(resolveWorktreeCleanup(custom, projectId).worktreeAfterDays).toBe(15);
    expect(custom.storageCleanup.logsAfterDays).toBe(3);
    const reset = applyServerSettingsPatch(custom, {
      projectSettingsOverrides: {
        [projectId]: clearProjectSettingsOverrides(custom, projectId, ["worktreeCleanup"]),
      },
    });
    expect(resolveWorktreeCleanup(reset, projectId)).toEqual(inherited);
  });
  it("completes partial machine custom rules and preserves them across edits", () => {
    const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      storageCleanup: { worktreeAfterDays: 8, worktreeOnDelete: true },
    });
    const custom = applyServerSettingsPatch(initial, {
      worktreeCleanup: { mode: "custom", rules: { worktreeOnMerge: true } },
    });
    const edited = applyServerSettingsPatch(custom, {
      worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 15 } },
    });
    expect(resolveWorktreeCleanup(edited, null)).toEqual({
      worktreeAfterDays: 15,
      worktreeOnDelete: true,
      worktreeOnMerge: true,
      worktreeUnchanged: false,
    });
    expect(
      resolveWorktreeCleanup(applyServerSettingsPatch(edited, { worktreeCleanup: null }), null)
        .worktreeAfterDays,
    ).toBe(8);
  });
});
