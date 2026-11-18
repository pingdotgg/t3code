import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";
import { msg, T, useGT, useMessages } from "gt-react";
import { AppWindowIcon, MonitorIcon, MoonIcon, PaletteIcon, SunIcon } from "lucide-react";

import { APP_ICON_OPTIONS, appIconOption } from "../appIcon";
import { m } from "../i18n/messages";
import { useCustomThemes } from "../hooks/useCustomThemes";
import { useEnvironmentThemeDefinitions } from "../hooks/useEnvironmentTheme";
import { updateClientSettings, useClientSettings } from "../hooks/useSettings";
import { APPEARANCE_CHOICES, useTheme, type AppearanceChoice } from "../hooks/useTheme";
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

const APPEARANCE_ICONS: Readonly<Record<AppearanceChoice, typeof MonitorIcon>> = {
  system: MonitorIcon,
  light: SunIcon,
  "black-chrome": AppWindowIcon,
  dark: MoonIcon,
};

export function notifyThemeSaveFailure(): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: m(msg("Couldn't save theme selection")),
      description: m(msg("Try again.")),
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
  const {
    theme,
    themeHalves,
    resolvedTheme,
    appearanceMode,
    appearanceChoice,
    setAppearanceChoice,
    setTheme,
    setThemeHalf,
  } = useTheme();
  const themeCards = useThemeCards();
  const gt = useGT();
  const messages = useMessages();
  const currentAppIcon = appIconOption(useClientSettings((settings) => settings.appIcon));

  const changeThemeItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-theme",
    searchTerms: ["change theme", "appearance", "colors", "palette"],
    title: gt("Change theme"),
    icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <PaletteIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "theme.select",
    groups: [
      {
        value: "themes",
        label: gt("Change theme"),
        items: themeCards.map(({ id, label, previews }) => ({
          kind: "action",
          value: id === null ? "theme:standard" : `theme:palette:${id}`,
          title: label,
          description:
            previews.length === 1
              ? previews[0]!.mode === "light"
                ? gt("For light mode")
                : gt("For dark mode")
              : undefined,
          searchTerms: [label, "theme", "appearance"],
          icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
          titleTrailingContent: (
            <span className="flex shrink-0 items-center gap-2">
              {(themeHalves?.[resolvedTheme] ?? getThemeDefinition(theme)?.id ?? null) === id ? (
                <span className="text-xs text-dim-foreground">
                  <T context="the theme or mode in use now">Current</T>
                </span>
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
    searchTerms: ["change appearance", "light", "dark", "system", "black chrome", "mode", "toggle"],
    title: gt("Change appearance"),
    icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <MonitorIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "appearance.cycle",
    groups: [
      {
        value: "appearance",
        label: gt("Change appearance"),
        items: APPEARANCE_CHOICES.map(({ choice, label }) => {
          const Icon = APPEARANCE_ICONS[choice];
          return {
            kind: "action" as const,
            value: `appearance:${choice}`,
            title: messages(label),
            searchTerms: [messages(label), label, "appearance", "mode"],
            icon: <Icon className={ITEM_ICON_CLASS} />,
            titleTrailingContent:
              appearanceChoice === choice ? (
                <span className="text-xs text-dim-foreground">
                  <T context="the theme or mode in use now">Current</T>
                </span>
              ) : undefined,
            run: async () => {
              if (!setAppearanceChoice(choice)) notifyThemeSaveFailure();
            },
          };
        }),
      },
    ],
  };

  const themeEditorItem: CommandPaletteActionItem = {
    kind: "action",
    value: "action:theme-editor",
    searchTerms: ["theme", "appearance", "colors", "palette", "customize"],
    title: gt("Toggle theme editor"),
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

  const changeAppIconItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-app-icon",
    searchTerms: ["change app icon", "dock", "taskbar", "favicon", "logo", "nightly"],
    title: gt("Change app icon"),
    icon: <AppWindowIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <AppWindowIcon className={ADDON_ICON_CLASS} />,
    groups: [
      {
        value: "app-icons",
        label: gt("Change app icon"),
        items: APP_ICON_OPTIONS.map((option) => ({
          kind: "action",
          value: `app-icon:${option.id}`,
          title: option.label,
          searchTerms: [option.label, "app icon"],
          icon: <img alt="" className="size-4" draggable={false} src={option.src} />,
          titleTrailingContent:
            currentAppIcon.id === option.id ? (
              <span className="text-meta text-dim-foreground">
                <T context="the theme or mode in use now">Current</T>
              </span>
            ) : undefined,
          run: () => updateClientSettings({ appIcon: option.id }),
        })),
      },
    ],
  };

  return { changeThemeItem, changeAppearanceItem, changeAppIconItem, themeEditorItem };
}
