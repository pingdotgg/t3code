import { t } from "@palamedes/core/macro";
import type { SettingsPath } from "./settingsSearch";

export function getSettingsSectionLabels(): Readonly<Record<SettingsPath, string>> {
  return {
    "/settings/diagnostics": t({ message: "Diagnostics" }),
    "/settings/projects": t({ message: "Projects" }),
    "/settings/general": t({ message: "General" }),
    "/settings/appearance": t({ message: "Appearance" }),
    "/settings/chat": t({ message: "Chat" }),
    "/settings/diffs": t({ message: "Diffs & pull requests" }),
    "/settings/keybindings": t({ message: "Keybindings" }),
    "/settings/snap-shot": t({ message: "SnapShots" }),
    "/settings/providers": t({ message: "Providers" }),
    "/settings/threads": t({ message: "Threads" }),
    "/settings/browser": t({ message: "Browser" }),
    "/settings/devices": t({ message: "Devices" }),
    "/settings/scheduled-tasks": t({ message: "Scheduled tasks" }),
    "/settings/source-control": t({ message: "Source control" }),
    "/settings/worktrees": t({ message: "Worktrees" }),
    "/settings/connections": t({ message: "Environments" }),
    "/settings/access": t({ message: "Sharing & access" }),
    "/settings/secrets": t({ message: "Secrets" }),
    "/settings/maintenance": t({ message: "Maintenance" }),
    "/settings/labs": t({ message: "Labs" }),
    "/settings/voice": t({ message: "Voice" }),
    "/settings/about": t({ message: "About" }),
    "/settings/archived": t({ message: "Archive" }),
  };
}

export function getAppearanceSettingTitles(): Readonly<Record<string, string>> {
  return {
    "interface-language": t`Interface language`,
    "setting-appearance-contrast": t({ message: "Contrast" }),
    "setting-glass-opacity": t({ message: "Glass opacity" }),
    "chat-width": t({ message: "Chat width" }),
    "effort-display": t({ message: "Effort display" }),
    "math-rendering": t({ message: "Render math" }),
    "panel-animations": t({ message: "Panel animations" }),
    "environment-identification": t({ message: "Environment identification" }),
    "composer-context": t({ message: "Composer context" }),
  };
}

export function getSettingsGroupLabel(heading: string): string {
  switch (heading) {
    case "Agents":
      return t`Agents`;
    case "Code":
      return t`Code`;
    case "Connections":
      return t`Connections`;
    default:
      return heading;
  }
}
