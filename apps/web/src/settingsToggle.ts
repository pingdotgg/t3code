export const SETTINGS_ROUTE_PATH = "/settings";

export interface SettingsToggleLocationSnapshot {
  readonly href: string;
}

export function resolveSettingsToggleNavigation(input: {
  pathname: string;
  href: string;
  previousLocation: SettingsToggleLocationSnapshot | null;
}): {
  destination: "settings" | "restore-previous";
  previousLocation: SettingsToggleLocationSnapshot | null;
  restoreHref: string | null;
} {
  if (input.pathname === SETTINGS_ROUTE_PATH) {
    return {
      destination: "restore-previous",
      previousLocation: null,
      restoreHref: input.previousLocation?.href ?? null,
    };
  }

  return {
    destination: "settings",
    previousLocation: { href: input.href },
    restoreHref: null,
  };
}
