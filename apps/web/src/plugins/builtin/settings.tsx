import { lazy } from "react";

import type { ClientPluginSdk } from "../PluginHost";
import { declareBuiltinFeatures } from "../features";

declareBuiltinFeatures("t3.settings", [
  "settings.layout",
  "settings.general",
  "settings.appearance",
  "settings.projects",
  "settings.keybindings",
  "settings.snap-shot",
  "settings.browser",
  "settings.devices",
  "settings.scheduled-tasks",
  "settings.source-control",
  "settings.maintenance",
  "settings.archived",
  "settings.diagnostics",
  "settings.open-source-licenses",
  "settings.plugins",
  "settings.about",
  "settings.chat",
  "settings.diffs",
  "settings.threads",
  "settings.worktrees",
  "settings.voice",
  "settings.labs",
  "settings.secrets",
]);

export function activate(sdk: ClientPluginSdk) {
  sdk.register([
    {
      slot: "settings.layout",
      order: -1000,
      component: lazy(() =>
        import("~/routes/_chat.settings").then((module) => ({
          default: module.BuiltinSettingsContentLayout,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.general",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/SettingsPanels").then((module) => ({
          default: module.PluginOriginalGeneralSettingsPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.appearance",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/AppearanceSettingsPanel").then((module) => ({
          default: module.PluginOriginalAppearanceSettingsPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.projects",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/ProjectsSettings").then((module) => ({
          default: module.PluginOriginalProjectsSettings,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.keybindings",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/KeybindingsSettings").then((module) => ({
          default: module.PluginOriginalKeybindingsSettingsPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.snap-shot",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/SnapShotSettings").then((module) => ({
          default: module.PluginOriginalSnapShotSettings,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.browser",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/IntegrationsSettings").then((module) => ({
          default: module.PluginOriginalBrowserSettingsPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.devices",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/IntegrationsSettings").then((module) => ({
          default: module.PluginOriginalDevicesSettingsPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.scheduled-tasks",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/SettingsScheduledTasksPage").then((module) => ({
          default: module.SettingsScheduledTasksRoute,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.source-control",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/SourceControlSettings").then((module) => ({
          default: module.PluginOriginalSourceControlSettingsPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.maintenance",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/SettingsPanels").then((module) => ({
          default: module.MaintenanceSettingsPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.archived",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/ArchivedThreadsPanel").then((module) => ({
          default: module.PluginOriginalArchivedThreadsPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.diagnostics",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/DiagnosticsSettings").then((module) => ({
          default: module.PluginOriginalDiagnosticsSettingsPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.open-source-licenses",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/OpenSourceLicenses").then((module) => ({
          default: module.PluginOriginalOpenSourceLicensesPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.plugins",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/PluginsSettings").then((module) => ({
          default: module.BuiltinPluginsSettingsPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.about",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/SettingsPanels").then((module) => ({
          default: module.AboutSettingsPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.chat",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/SettingsPanels").then((module) => ({
          default: module.ChatSettingsPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.diffs",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/SettingsPanels").then((module) => ({
          default: module.DiffsSettingsPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.threads",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/SettingsPanels").then((module) => ({
          default: module.ThreadsSettingsPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.worktrees",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/WorktreesSettings").then((module) => ({
          default: module.WorktreesSettingsPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.voice",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/VoiceSettingsPanel").then((module) => ({
          default: module.VoiceSettingsPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.labs",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/LabsSettingsPanel").then((module) => ({
          default: module.LabsSettingsPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.secrets",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/SecretsSettings").then((module) => ({
          default: module.SecretsSettingsPanel,
        })),
      ),
    },
  ]);
}
