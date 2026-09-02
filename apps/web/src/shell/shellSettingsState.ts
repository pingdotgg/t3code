import type { ShellSettingsState } from "@t3tools/contracts/shell";

import {
  SETTINGS_SECTION_LABELS,
  searchSettings,
  type SettingsPath,
} from "../components/settings/settingsSearch";

export const SETTINGS_SECTIONS: ReadonlyArray<{ to: SettingsPath; label: string }> = (
  Object.keys(SETTINGS_SECTION_LABELS) as SettingsPath[]
).map((to) => ({ to, label: SETTINGS_SECTION_LABELS[to] }));

export function isSettingsPath(value: string): value is SettingsPath {
  return value in SETTINGS_SECTION_LABELS;
}

export function resolveActiveSettingsSection(pathname: string): SettingsPath | null {
  return (
    SETTINGS_SECTIONS.find(
      (section) => pathname === section.to || pathname.startsWith(`${section.to}/`),
    )?.to ?? null
  );
}

export function buildShellSettingsState(input: {
  readonly pathname: string;
  readonly searchQuery: string;
}): ShellSettingsState {
  return {
    active: input.pathname === "/settings" || input.pathname.startsWith("/settings/"),
    sections: SETTINGS_SECTIONS,
    activeSection: resolveActiveSettingsSection(input.pathname),
    searchQuery: input.searchQuery,
    searchResults: searchSettings(input.searchQuery).map((item) => ({
      id: item.id,
      title: item.title,
      to: item.to,
      sectionLabel: SETTINGS_SECTION_LABELS[item.to],
      targetId: item.targetId ?? null,
    })),
  };
}
