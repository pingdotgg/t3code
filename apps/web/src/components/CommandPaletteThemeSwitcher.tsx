import { CheckIcon, PaintbrushIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import type { AppearanceSettings, ThemeDocument } from "@t3tools/contracts";
import {
  getAppearanceThemeById,
  getAppearanceThemes,
  resolveAppearanceTheme,
} from "@t3tools/shared/appearance";

import { previewTheme } from "../hooks/useTheme";
import type { CommandPaletteActionItem, CommandPaletteView } from "./CommandPalette.logic";

export const THEME_ADDON_ICON_CLASS = "size-4 text-muted-foreground/70";

export interface ThemeSwitcherOptions {
  appearance: AppearanceSettings;
  updateAppearance: (appearance: AppearanceSettings) => void;
  addonIconClass?: string;
}

/**
 * Color swatch showing theme background, foreground "Ab" text, accent, and neutral colors.
 */
function ThemeColorSwatch({ theme }: { theme: ThemeDocument }) {
  return (
    <div
      className="flex h-3.5 w-20 overflow-hidden rounded-[3px] border border-border/50"
      aria-hidden="true"
    >
      <div
        className="flex w-6 items-center justify-center text-[8px] font-medium"
        style={{ backgroundColor: theme.backgroundSeed, color: theme.foregroundSeed }}
      >
        Ab
      </div>
      <div className="flex-1" style={{ backgroundColor: theme.accentSeed }} />
      <div
        className="flex-1"
        style={{ backgroundColor: theme.neutralSeed ?? theme.foregroundSeed }}
      />
      <div className="flex-1" style={{ backgroundColor: theme.foregroundSeed }} />
    </div>
  );
}

export function buildThemeItems({
  appearance,
  updateAppearance,
}: ThemeSwitcherOptions): CommandPaletteActionItem[] {
  const selectedTheme = resolveAppearanceTheme(appearance);
  const allThemes = getAppearanceThemes();

  // Sort themes: current theme first, then alphabetically
  const sortedThemes = [...allThemes].sort((a, b) => {
    if (a.id === selectedTheme.id) return -1;
    if (b.id === selectedTheme.id) return 1;
    return a.name.localeCompare(b.name);
  });

  return sortedThemes.map((theme) => {
    const isSelected = theme.id === selectedTheme.id;
    return {
      kind: "action",
      value: `theme:${theme.id}`,
      searchTerms: ["theme", "appearance", "color", "switch", theme.name, theme.mode],
      title: (
        <span className="flex items-center gap-2">
          <span className="flex-1 truncate">{theme.name}</span>
          <ThemeColorSwatch theme={theme} />
          {isSelected && <CheckIcon className="size-3.5 text-primary" />}
        </span>
      ),
      icon: null,
      run: async () => {
        updateAppearance({ ...appearance, themeId: theme.id });
      },
    };
  });
}

export function buildThemeSwitcherView(
  themeItems: CommandPaletteActionItem[],
  currentThemeValue: string,
  addonIconClass: string = THEME_ADDON_ICON_CLASS,
): CommandPaletteView {
  return {
    addonIcon: <PaintbrushIcon className={addonIconClass} />,
    initialQuery: "",
    initialHighlightedValue: currentThemeValue,
    groups: [{ value: "themes", label: "Themes", items: themeItems }],
  };
}

/**
 * Extract a theme ID from a command palette item value.
 * Returns null if the value doesn't represent a theme item.
 */
export function extractThemeIdFromValue(value: string | null): string | null {
  if (!value || !value.startsWith("theme:")) return null;
  return value.slice("theme:".length);
}

export function useThemeSwitcher(options: ThemeSwitcherOptions): {
  themeItems: CommandPaletteActionItem[];
  themeSwitcherView: CommandPaletteView;
  themeSearchTerms: string[];
  currentThemeValue: string;
} {
  const { addonIconClass = THEME_ADDON_ICON_CLASS } = options;

  const currentTheme = resolveAppearanceTheme(options.appearance);
  const currentThemeValue = `theme:${currentTheme.id}`;

  const themeItems = useMemo(
    () => buildThemeItems(options),
    [options.appearance, options.updateAppearance],
  );

  const themeSwitcherView = useMemo(
    () => buildThemeSwitcherView(themeItems, currentThemeValue, addonIconClass),
    [themeItems, currentThemeValue, addonIconClass],
  );

  const themeSearchTerms = useMemo(() => getAppearanceThemes().map((theme) => theme.name), []);

  return { themeItems, themeSwitcherView, themeSearchTerms, currentThemeValue };
}

/**
 * Hook to manage live theme preview while navigating the command palette.
 * Previews theme on highlight, reverts when leaving theme items or closing palette.
 */
export function useThemePreview(
  highlightedItemValue: string | null,
  isThemeSwitcherActive: boolean,
  appearance: AppearanceSettings,
): void {
  const previewingRef = useRef(false);

  // Preview theme when highlighting a theme item
  useEffect(() => {
    if (!isThemeSwitcherActive) {
      // Not in theme switcher view; restore if we were previewing
      if (previewingRef.current) {
        previewTheme(null, appearance);
        previewingRef.current = false;
      }
      return;
    }

    const themeId = extractThemeIdFromValue(highlightedItemValue);
    if (themeId) {
      const theme = getAppearanceThemeById(themeId);
      if (theme) {
        previewTheme(theme, appearance);
        previewingRef.current = true;
      }
    } else if (previewingRef.current) {
      // Highlighted something that's not a theme (or nothing); restore
      previewTheme(null, appearance);
      previewingRef.current = false;
    }
  }, [highlightedItemValue, isThemeSwitcherActive, appearance]);

  // Restore on unmount (e.g., palette closes)
  useEffect(() => {
    return () => {
      if (previewingRef.current) {
        previewTheme(null, appearance);
        previewingRef.current = false;
      }
    };
  }, [appearance]);
}
