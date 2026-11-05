import { t } from "@palamedes/core/macro";
import { Trans } from "@palamedes/react/macro";
import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";
import { MonitorIcon, MoonIcon, PaletteIcon, SunIcon } from "lucide-react";

import { useCustomThemes } from "../hooks/useCustomThemes";
import { useEnvironmentThemeDefinitions } from "../hooks/useEnvironmentTheme";
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
  {
    mode: "system",
    get label() {
      return t({ message: "System" });
    },
    icon: MonitorIcon,
  },
  {
    mode: "light",
    get label() {
      return t({ message: "Light" });
    },
    icon: SunIcon,
  },
  {
    mode: "dark",
    get label() {
      return t({ message: "Dark" });
    },
    icon: MoonIcon,
  },
] as const;

export function notifyThemeSaveFailure(): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: t({ message: "Couldn't save theme selection" }),
      description: t({ message: "Try again." }),
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
    setAppearanceMode,
    setTheme,
    setThemeHalf,
  } = useTheme();
  const themeCards = useThemeCards();

  const changeThemeItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-theme",
    searchTerms: ["change theme", "appearance", "colors", "palette"],
    title: t({ message: "Change theme" }),
    icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <PaletteIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "theme.select",
    groups: [
      {
        value: "themes",
        label: t({ message: "Change theme" }),
        items: themeCards.map(({ id, label, previews }) => {
          const messageText = previews.length === 1 ? previews[0]!.mode : undefined;
          return {
            kind: "action",
            value: id === null ? "theme:standard" : `theme:palette:${id}`,
            title: label,
            description: previews.length === 1 ? t`For ${messageText} mode` : undefined,
            searchTerms: [label, "theme", "appearance"],
            icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
            titleTrailingContent: (
              <span className="flex shrink-0 items-center gap-2">
                {(themeHalves?.[resolvedTheme] ?? getThemeDefinition(theme)?.id ?? null) === id ? (
                  <span className="text-xs text-muted-foreground/70">
                    <Trans>Current</Trans>
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
          };
        }),
      },
    ],
  };

  const changeAppearanceItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-appearance",
    searchTerms: ["change appearance", "light", "dark", "system", "mode", "toggle"],
    title: t({ message: "Change appearance" }),
    icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <MonitorIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "appearance.cycle",
    groups: [
      {
        value: "appearance",
        label: t({ message: "Change appearance" }),
        items: APPEARANCE_OPTIONS.map(({ mode, label, icon: Icon }) => ({
          kind: "action",
          value: `appearance:${mode}`,
          title: label,
          searchTerms: [label, "appearance", "mode"],
          icon: <Icon className={ITEM_ICON_CLASS} />,
          titleTrailingContent:
            appearanceMode === mode ? (
              <span className="text-xs text-muted-foreground/70">
                <Trans>Current</Trans>
              </span>
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
    title: t({ message: "Toggle theme editor" }),
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
