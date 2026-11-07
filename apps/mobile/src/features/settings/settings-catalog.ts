import {
  settingsNavGroupsForSurface,
  type SettingsSectionId,
} from "@t3tools/client-runtime/settings/catalog";
import { Platform } from "react-native";

import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { navigationCustomizationAvailable } from "../layout/workspace/navigation-tab-order";
import { MOBILE_SETTINGS_PAGE_BY_SECTION } from "./settings-catalog-coverage";

export {
  MOBILE_IMPLEMENTED_SETTINGS_SECTIONS,
  MOBILE_SETTINGS_PAGE_BY_SECTION,
} from "./settings-catalog-coverage";

const SECTION_ICONS: Partial<Record<SettingsSectionId, AppSymbolName>> = {
  general: "gearshape",
  appearance: "paintbrush",
  chat: "bubble.left.and.bubble.right",
  diffs: "arrow.left.arrow.right",
  voice: "mic",
  navigation: "line.3.horizontal",
  keyboard: "keyboard",
  notifications: "bell.badge",
  providers: "person.crop.circle",
  threads: "text.bubble",
  browser: "safari",
  devices: "iphone",
  "scheduled-tasks": "clock",
  projects: "folder",
  "source-control": "arrow.triangle.branch",
  worktrees: "square.on.square",
  connections: "desktopcomputer",
  access: "exclamationmark.shield",
  secrets: "exclamationmark.shield",
  maintenance: "arrow.clockwise",
  labs: "sparkles",
  about: "info.circle",
  archived: "archivebox",
  diagnostics: "stethoscope",
};

/** Index rows under Device / Agents / Code / footer. Connections stay a separate list block. */
export function mobileSettingsIndexGroups(options?: { readonly secretsFeatureEnabled?: boolean }) {
  const secretsFeatureEnabled = options?.secretsFeatureEnabled ?? false;
  return settingsNavGroupsForSurface("mobile", { secretsFeatureEnabled }).flatMap((group) => {
    // Environments / Notifications / Access / Secrets are composed in SettingsRouteScreen.
    if (group.id === "connections") return [];
    const rows = group.sections.flatMap((section) => {
      if (section.id === "keyboard" && Platform.OS !== "ios") return [];
      if (section.id === "navigation" && !navigationCustomizationAvailable()) return [];
      if (!Object.hasOwn(MOBILE_SETTINGS_PAGE_BY_SECTION, section.id)) return [];
      const target =
        MOBILE_SETTINGS_PAGE_BY_SECTION[section.id as keyof typeof MOBILE_SETTINGS_PAGE_BY_SECTION];
      return [
        {
          id: section.id,
          target,
          icon: SECTION_ICONS[section.id] ?? "gearshape",
          label: section.label,
          serverOwned: section.ownership === "server" || section.ownership === "hybrid",
        },
      ];
    });
    if (rows.length === 0) return [];
    return [{ title: group.heading ?? undefined, rows }];
  });
}
