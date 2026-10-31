import type { SearchMiddleware } from "@tanstack/react-router";

import { validateSettingsScopeSearch, type SettingsScopeSearch } from "./settingsScope";

export function validateSettingsRouteSearch(
  raw: Record<string, unknown>,
): SettingsScopeSearch & { pane?: 1 | undefined } {
  return {
    ...validateSettingsScopeSearch(
      typeof raw.environmentId === "string" &&
        raw.machine === undefined &&
        raw.project === undefined
        ? { ...raw, machine: raw.environmentId }
        : raw,
    ),
    ...(raw.pane === 1 || raw.pane === "1" ? { pane: 1 as const } : {}),
  };
}

const SCOPE_KEYS = [
  "project",
  "machine",
  "checkout",
] as const satisfies readonly (keyof SettingsScopeSearch)[];
const TARGET_INPUT_KEYS = [...SCOPE_KEYS, "environmentId"];

export const retainSettingsScope: SearchMiddleware<
  SettingsScopeSearch & { pane?: 1 | undefined }
> = ({ search, next }) => {
  const result = next(search);
  const plane = Object.hasOwn(result, "pane") ? {} : search.pane === 1 ? { pane: 1 as const } : {};
  if (TARGET_INPUT_KEYS.some((key) => Object.hasOwn(result, key))) return { ...plane, ...result };
  const previousScope = Object.fromEntries(
    SCOPE_KEYS.filter((key) => search[key] !== undefined).map((key) => [key, search[key]]),
  );
  return { ...previousScope, ...plane, ...result };
};
