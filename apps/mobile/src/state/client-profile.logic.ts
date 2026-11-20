import { ChatWidth, SidebarProjectGroupingMode, ToolCallVisibility } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { DEFAULT_FOLLOW_UP_BEHAVIOR } from "../lib/followUpBehavior";
import {
  getRegisteredMobileTheme,
  isUsableMobileThemeForAppearance,
} from "../lib/mobileThemeRegistry";
import {
  createMobileThemeSelectionPatch,
  MOBILE_THEME_IDS,
  normalizeMobileThemeMode,
  resolveMobileThemeIds,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeMode,
} from "../lib/mobileTheme";
import type { Preferences } from "../persistence/mobile-preferences";
import {
  mobileProjectGroupingModePatch,
  resolveMobileProjectGroupingSettings,
} from "./project-grouping.logic";

const isToolCallVisibility = Schema.is(ToolCallVisibility);
const isGroupingMode = Schema.is(SidebarProjectGroupingMode);
const isChatWidth = Schema.is(ChatWidth);

function syncableThemeId(
  value: unknown,
  appearance: MobileThemeAppearance,
): MobileThemeId | undefined {
  if (typeof value !== "string" || value === "material-you") return undefined;
  if ((MOBILE_THEME_IDS as readonly string[]).includes(value)) return value;
  const registered = getRegisteredMobileTheme(value);
  return registered !== null && isUsableMobileThemeForAppearance(registered, appearance)
    ? value
    : undefined;
}

export function readMobileProfileValues(preferences: Preferences): Record<string, unknown> {
  const themeIds = resolveMobileThemeIds(preferences);
  return {
    themeMode: normalizeMobileThemeMode(preferences.themeMode),
    ...(themeIds.light === "material-you" ? {} : { themeLight: themeIds.light }),
    ...(themeIds.dark === "material-you" ? {} : { themeDark: themeIds.dark }),
    toolCallVisibility: preferences.toolCallVisibility ?? "showAll",
    followUpBehavior: preferences.followUpBehavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR,
    mathRenderingEnabled: preferences.mathRenderingEnabled === true,
    sidebarProjectGroupingMode:
      resolveMobileProjectGroupingSettings(preferences).sidebarProjectGroupingMode,
    sidebarWorkingShelfEnabled: preferences.workingShelfEnabled !== false,
    chatWidth: preferences.chatWidth ?? "comfortable",
  };
}

export function mobileProfilePatch(
  preferences: Preferences,
  values: Readonly<Record<string, unknown>>,
  systemAppearance: "light" | "dark",
): Partial<Preferences> {
  const patch: { -readonly [K in keyof Preferences]: Preferences[K] } = {};

  const mode: MobileThemeMode | undefined =
    values.themeMode === "system" || values.themeMode === "light" || values.themeMode === "dark"
      ? values.themeMode
      : undefined;
  if (mode !== undefined) patch.themeMode = mode;

  const light = syncableThemeId(values.themeLight, "light");
  const dark = syncableThemeId(values.themeDark, "dark");
  if (light !== undefined || dark !== undefined) {
    const effectiveMode = mode ?? normalizeMobileThemeMode(preferences.themeMode);
    const active: MobileThemeAppearance =
      effectiveMode === "system" ? systemAppearance : effectiveMode;
    let themeIds = resolveMobileThemeIds(preferences);
    let themePatch = { ...themeIds, themeId: themeIds[active] } as Partial<Preferences>;
    for (const [appearance, id] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      if (id === undefined) continue;
      const next = createMobileThemeSelectionPatch(themeIds, active, appearance, id);
      themeIds = { light: next.lightThemeId, dark: next.darkThemeId };
      themePatch = next;
    }
    Object.assign(patch, themePatch);
  }

  if (isToolCallVisibility(values.toolCallVisibility)) {
    patch.toolCallVisibility = values.toolCallVisibility;
  }
  if (values.followUpBehavior === "queue" || values.followUpBehavior === "steer") {
    patch.followUpBehavior = values.followUpBehavior;
  }
  if (typeof values.mathRenderingEnabled === "boolean") {
    patch.mathRenderingEnabled = values.mathRenderingEnabled;
  }
  if (isGroupingMode(values.sidebarProjectGroupingMode)) {
    Object.assign(patch, mobileProjectGroupingModePatch(values.sidebarProjectGroupingMode));
  }
  if (typeof values.sidebarWorkingShelfEnabled === "boolean") {
    patch.workingShelfEnabled = values.sidebarWorkingShelfEnabled;
  }
  if (isChatWidth(values.chatWidth)) patch.chatWidth = values.chatWidth;
  return patch;
}

export function applyMobileProfileValues(input: {
  readonly preferences: Preferences;
  readonly values: Readonly<Record<string, unknown>>;
  readonly systemAppearance: "light" | "dark";
  readonly write: (patch: Partial<Preferences>) => Preferences;
}): Record<string, unknown> {
  const patch = mobileProfilePatch(input.preferences, input.values, input.systemAppearance);
  const stored = Object.keys(patch).length === 0 ? input.preferences : input.write(patch);
  return Object.fromEntries(
    Object.entries(readMobileProfileValues(stored)).filter(([base]) => base in input.values),
  );
}
