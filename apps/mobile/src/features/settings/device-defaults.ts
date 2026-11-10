import { DEFAULT_BASE_FONT_SIZE, normalizeBaseFontSize } from "../../lib/appearancePreferences";
import { DEFAULT_COMPOSER_ENTER_BEHAVIOR } from "../../lib/composerEnterBehavior";
import { DEFAULT_FOLLOW_UP_BEHAVIOR } from "../../lib/followUpBehavior";
import { microphoneEntryKey, microphoneOrder } from "../../lib/microphonePriority";
import {
  DEFAULT_MOBILE_THEME_ID,
  normalizeMobileThemeMode,
  resolveMobileThemeIds,
} from "../../lib/mobileTheme";
import type { Preferences } from "../../persistence/mobile-preferences";
import {
  mobileProjectGroupingModePatch,
  resolveMobileProjectGroupingSettings,
} from "../../state/project-grouping.logic";
import {
  NAVIGATION_TAB_ORDER,
  resolveHiddenNavigationTabs,
  resolveNavigationTabOrder,
} from "../layout/workspace/navigation-tab-order";

interface DeviceDefaultEntry {
  readonly id: string;
  readonly label: string;
  readonly isDefault: (preferences: Preferences) => boolean;
  readonly patch: () => Partial<Preferences>;
}

const DEVICE_DEFAULT_ENTRIES: readonly DeviceDefaultEntry[] = [
  {
    id: "color-scheme",
    label: "Color scheme",
    isDefault: (preferences) => normalizeMobileThemeMode(preferences.themeMode) === "system",
    patch: () => ({ themeMode: "system" }),
  },
  {
    id: "themes",
    label: "Themes",
    isDefault: (preferences) => {
      const themeIds = resolveMobileThemeIds(preferences);
      return (
        themeIds.light === DEFAULT_MOBILE_THEME_ID && themeIds.dark === DEFAULT_MOBILE_THEME_ID
      );
    },
    patch: () => ({
      themeId: DEFAULT_MOBILE_THEME_ID,
      lightThemeId: DEFAULT_MOBILE_THEME_ID,
      darkThemeId: DEFAULT_MOBILE_THEME_ID,
    }),
  },
  {
    id: "navigation-style",
    label: "Navigation style",
    isDefault: (preferences) => preferences.androidNavigationStyle == null,
    patch: () => ({ androidNavigationStyle: null }),
  },
  {
    id: "text-size",
    label: "Text size",
    isDefault: (preferences) =>
      normalizeBaseFontSize(preferences.baseFontSize ?? preferences.markdownFontSize) ===
      DEFAULT_BASE_FONT_SIZE,
    patch: () => ({ baseFontSize: DEFAULT_BASE_FONT_SIZE }),
  },
  {
    id: "render-math",
    label: "Render math",
    isDefault: (preferences) => preferences.mathRenderingEnabled !== true,
    patch: () => ({ mathRenderingEnabled: false }),
  },
  {
    id: "terminal-font-size",
    label: "Terminal font size",
    isDefault: (preferences) =>
      preferences.terminalFontSize === null || preferences.terminalFontSize === undefined,
    patch: () => ({ terminalFontSize: null }),
  },
  {
    id: "code-font-size",
    label: "Code font size",
    isDefault: (preferences) =>
      preferences.codeFontSize === null || preferences.codeFontSize === undefined,
    patch: () => ({ codeFontSize: null }),
  },
  {
    id: "word-break",
    label: "Word break",
    isDefault: (preferences) => preferences.codeWordBreak !== true,
    patch: () => ({ codeWordBreak: false }),
  },
  {
    id: "project-grouping",
    label: "Project grouping",
    isDefault: (preferences) =>
      resolveMobileProjectGroupingSettings(preferences).sidebarProjectGroupingMode === "repository",
    patch: () => mobileProjectGroupingModePatch("repository"),
  },
  {
    id: "working-section",
    label: "Working section",
    isDefault: (preferences) => preferences.workingShelfEnabled !== false,
    patch: () => ({ workingShelfEnabled: true }),
  },
  {
    id: "use-last-project",
    label: "Use last project",
    isDefault: (preferences) => preferences.useLastProjectForNewThreads !== false,
    patch: () => ({ useLastProjectForNewThreads: true }),
  },
  {
    id: "navigation-tabs",
    label: "Navigation tabs",
    isDefault: (preferences) => {
      const order = resolveNavigationTabOrder(preferences.navigationTabOrder);
      return (
        order.length === NAVIGATION_TAB_ORDER.length &&
        order.every((tab, index) => tab === NAVIGATION_TAB_ORDER[index]) &&
        resolveHiddenNavigationTabs(preferences.hiddenNavigationTabs).length === 0
      );
    },
    patch: () => ({ navigationTabOrder: [], hiddenNavigationTabs: [] }),
  },
  {
    id: "follow-ups",
    label: "Follow-ups",
    isDefault: (preferences) =>
      (preferences.followUpBehavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR) === DEFAULT_FOLLOW_UP_BEHAVIOR,
    patch: () => ({ followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR }),
  },
  {
    id: "return-key",
    label: "Return key",
    isDefault: (preferences) =>
      (preferences.composerEnterBehavior ?? DEFAULT_COMPOSER_ENTER_BEHAVIOR) ===
      DEFAULT_COMPOSER_ENTER_BEHAVIOR,
    patch: () => ({ composerEnterBehavior: DEFAULT_COMPOSER_ENTER_BEHAVIOR }),
  },
  {
    id: "voice-input",
    label: "Voice input order",
    isDefault: (preferences) => {
      const current = microphoneOrder(preferences.microphones).map(microphoneEntryKey);
      const defaults = microphoneOrder([]).map(microphoneEntryKey);
      return (
        current.length === defaults.length && current.every((key, index) => key === defaults[index])
      );
    },
    patch: () => ({ microphones: [] }),
  },
];

export function getChangedDevicePreferenceLabels(preferences: Preferences): string[] {
  return DEVICE_DEFAULT_ENTRIES.flatMap((entry) =>
    entry.isDefault(preferences) ? [] : [entry.label],
  );
}

export function isDevicePreferencesDefault(preferences: Preferences): boolean {
  return DEVICE_DEFAULT_ENTRIES.every((entry) => entry.isDefault(preferences));
}

export function buildRestoreDeviceDefaultsPatch(): Partial<Preferences> {
  return Object.assign({}, ...DEVICE_DEFAULT_ENTRIES.map((entry) => entry.patch()));
}
