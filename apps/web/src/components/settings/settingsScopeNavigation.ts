import type { SearchMiddleware } from "@tanstack/react-router";

import { validateSettingsScopeSearch, type SettingsScopeSearch } from "./settingsScope";

export function validateSettingsRouteSearch(raw: Record<string, unknown>) {
  return validateSettingsScopeSearch(
    typeof raw.environmentId === "string" && raw.machine === undefined && raw.project === undefined
      ? { ...raw, machine: raw.environmentId }
      : raw,
  );
}

const SCOPE_KEYS = [
  "project",
  "machine",
  "checkout",
] as const satisfies readonly (keyof SettingsScopeSearch)[];
const TARGET_INPUT_KEYS = [...SCOPE_KEYS, "environmentId"];

/** Retain middleware keeps the selected project, so re-clicking Projects must drop it explicitly. */
export function settingsSectionSearch(to: string, pathname: string) {
  if (to !== "/settings/projects" || pathname !== to) return undefined;
  return (previous: SettingsScopeSearch): SettingsScopeSearch => ({
    project: undefined,
    checkout: undefined,
    machine: previous.machine,
  });
}

export const retainSettingsScope: SearchMiddleware<SettingsScopeSearch> = ({ search, next }) => {
  const result = next(search);
  if (TARGET_INPUT_KEYS.some((key) => Object.hasOwn(result, key))) return result;
  const previousScope = Object.fromEntries(
    SCOPE_KEYS.filter((key) => search[key] !== undefined).map((key) => [key, search[key]]),
  );
  return { ...previousScope, ...result };
};
