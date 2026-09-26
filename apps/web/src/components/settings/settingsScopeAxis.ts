import { ALL_ENVIRONMENTS_VALUE } from "../EnvironmentScopeRadioItems";
import type { SettingsScopeSearch } from "./settingsScope";

export const ALL_PROJECTS_VALUE = "all";

/**
 * The environment axis: `all` or an environment id. A legacy checkout link
 * without `machine` still names one environment, which the resolver supplies.
 */
export function environmentAxisValue(
  search: SettingsScopeSearch,
  resolvedEnvironmentId?: string | null,
): string {
  return search.machine ?? resolvedEnvironmentId ?? ALL_ENVIRONMENTS_VALUE;
}

/** The project axis: `all` or a project key. */
export function projectAxisValue(search: SettingsScopeSearch): string {
  return search.project ?? ALL_PROJECTS_VALUE;
}

/** Choosing an environment keeps the project; a pre-existing checkout narrowing is dropped. */
export function selectEnvironmentAxis(
  search: SettingsScopeSearch,
  value: string,
): SettingsScopeSearch {
  const next: SettingsScopeSearch = {};
  if (search.project) next.project = search.project;
  if (value !== ALL_ENVIRONMENTS_VALUE) next.machine = value;
  return next;
}

/** Choosing a project keeps the environment axis. */
export function selectProjectAxis(search: SettingsScopeSearch, value: string): SettingsScopeSearch {
  const next: SettingsScopeSearch = {};
  if (value !== ALL_PROJECTS_VALUE) next.project = value;
  if (search.machine) next.machine = search.machine;
  return next;
}
