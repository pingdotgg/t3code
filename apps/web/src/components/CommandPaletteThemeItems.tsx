import { createTranslator } from "@t3tools/client-runtime/i18n";
import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";
import { MonitorIcon, MoonIcon, PaletteIcon, SunIcon } from "lucide-react";

import { useCustomThemes } from "../hooks/useCustomThemes";
import { useEnvironmentThemeDefinitions } from "../hooks/useEnvironmentTheme";
import { getUiLocale, useT } from "../hooks/useI18n";
import { useTheme } from "../hooks/useTheme";
import { getThemeDefinition } from "../themePalette";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import { toggleThemeEditorForTheme } from "./settings/themeEditorStore";
import {
  STANDARD_THEME_CARDS,
  getThemeCardDefinition,
  ThemePreviewCircle,
} from "./settings/ThemePreviewCircles";
import { stackedThreadToast, toastManager } from "./ui/toast";

export const APPEARANCE_OPTIONS = [
  { mode: "system", label: "System", labelKey: "app.palette.appearance.system", icon: MonitorIcon },
  { mode: "light", label: "Light", labelKey: "app.palette.appearance.light", icon: SunIcon },
  { mode: "dark", label: "Dark", labelKey: "app.palette.appearance.dark", icon: MoonIcon },
] as const;

export function notifyThemeSaveFailure(): void {
  const t = createTranslator(getUiLocale());
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: t("app.palette.themeSaveFailed"),
      description: t("app.palette.tryAgain"),
    }),
  );
}

// Reads its own source hooks so the compiler caches the cards on them. Taking the
// sources as arguments would leave it hook-free, and the compiler would cache nothing.
function useThemeCards() {
  const customThemes = useCustomThemes();
  const environmentThemes = useEnvironmentThemeDefinitions();
  const seen = new Set<string>();
  return [
    ...STANDARD_THEME_CARDS.map((card) => ({ ...card, id: null })),
    ...[...BUILT_IN_THEMES, ...customThemes, ...environmentThemes]
      .filter((definition) => {
        if (seen.has(definition.id)) return false;
        seen.add(definition.id);
        return true;
      })
      .map(getThemeCardDefinition),
  ];
}

export function useCommandPaletteThemeItems() {
  const t = useT();
  const {
    theme,
    themeHalves,
    resolvedTheme,
    appearanceMode,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
  } = useTheme();
  const themeCards = useThemeCards();

  const changeThemeItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-theme",
    searchTerms: ["change theme", "appearance", "colors", "palette"],
    title: t("app.palette.changeTheme"),
    icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <PaletteIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "theme.select",
    groups: [
      {
        value: "themes",
        label: t("app.palette.changeTheme"),
        items: themeCards.map(({ id, label, previews }) => ({
          kind: "action",
          value: id === null ? "theme:standard" : `theme:palette:${id}`,
          title: label,
          description:
            previews.length === 1
              ? t(
                  previews[0]!.mode === "dark"
                    ? "app.palette.forDarkMode"
                    : "app.palette.forLightMode",
                )
              : undefined,
          searchTerms: [label, "theme", "appearance"],
          icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
          titleTrailingContent: (
            <span className="flex shrink-0 items-center gap-2">
              {(themeHalves?.[resolvedTheme] ?? getThemeDefinition(theme)?.id ?? null) === id ? (
                <span className="text-xs text-muted-foreground/70">{t("app.palette.current")}</span>
              ) : null}
              <span className="flex items-center gap-1" aria-hidden>
                {previews.map((preview) => (
                  <ThemePreviewCircle
                    key={preview.mode}
                    colors={preview.colors}
                    mode={preview.mode}
                    className="size-3 border-0"
                  />
                ))}
              </span>
            </span>
          ),
          run: async () => {
            const saved =
              previews.length === 1 && id !== null
                ? setThemeHalf(previews[0]!.mode, id)
                : setTheme(id ?? appearanceMode);
            if (!saved) notifyThemeSaveFailure();
          },
        })),
      },
    ],
  };

  const changeAppearanceItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-appearance",
    searchTerms: ["change appearance", "light", "dark", "system", "mode", "toggle"],
    title: t("app.palette.changeAppearance"),
    icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <MonitorIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "appearance.cycle",
    groups: [
      {
        value: "appearance",
        label: t("app.palette.changeAppearance"),
        items: APPEARANCE_OPTIONS.map(({ mode, label, labelKey, icon: Icon }) => ({
          kind: "action",
          value: `appearance:${mode}`,
          title: t(labelKey),
          searchTerms: [label, "appearance", "mode"],
          icon: <Icon className={ITEM_ICON_CLASS} />,
          titleTrailingContent:
            appearanceMode === mode ? (
              <span className="text-xs text-muted-foreground/70">{t("app.palette.current")}</span>
            ) : undefined,
          run: async () => {
            if (!setAppearanceMode(mode)) notifyThemeSaveFailure();
          },
        })),
      },
    ],
  };

  const themeEditorItem: CommandPaletteActionItem = {
    kind: "action",
    value: "action:theme-editor",
    searchTerms: ["theme", "appearance", "colors", "palette", "customize"],
    title: t("app.palette.toggleThemeEditor"),
    icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "themeEditor.toggle",
    run: async () => {
      toggleThemeEditorForTheme({
        theme,
        themeHalves,
        initialAppearance: resolvedTheme,
      });
    },
  };

  return { changeThemeItem, changeAppearanceItem, themeEditorItem };
}
