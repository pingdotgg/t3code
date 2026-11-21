import { defineNativeBuiltinPlugin } from "./define";

export const nativeSettingsPlugin = defineNativeBuiltinPlugin("t3.settings", [
  "settings",
  "settings.about",
  "settings.appearance",
  "settings.storage",
  "settings.follow-ups",
  "settings.keybindings",
  "settings.legal",
  "settings.notifications",
  "settings.licenses",
  "settings.license",
  "settings.plugins",
  "settings.projects",
  "settings.project-overview",
  "settings.scheduled-tasks",
  "settings.source-control",
  "settings.maintenance",
  "settings.threads",
  "settings.worktrees",
  "native.features.diagnostics.settings-diagnostics-route-screen",
]);
