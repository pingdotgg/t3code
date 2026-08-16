import { MoonIcon, SunIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  getThemeColorsForMode,
  getThemeModes,
  type ThemeAppearance,
  type ThemeDefinition,
} from "../../themePalette";

const THEME_PREVIEW_ROLES = [
  "sidebar",
  "canvas",
  "surface",
  "accentSurface",
  "accent",
  "messageSurface",
  "messageAction",
] as const;
type ThemePreviewRole = (typeof THEME_PREVIEW_ROLES)[number];
type ThemeCardPreview = {
  mode: ThemeAppearance;
  colors: Readonly<Record<ThemePreviewRole, string>>;
};
export type ThemeCardDefinition = {
  id: string;
  label: string;
  previews: ReadonlyArray<ThemeCardPreview>;
};
export type ThemeMode = ThemeAppearance | "system";
export type ThemeCardPreviewColors = ThemeCardPreview["colors"];

const STANDARD_THEME_PREVIEW_COLORS: Record<
  ThemeAppearance,
  Readonly<Record<ThemePreviewRole, string>>
> = {
  light: {
    sidebar: "#fafafa",
    canvas: "#fcfcfc",
    surface: "#ffffff",
    accentSurface: "#f4f4f5",
    accent: "#f4f4f5",
    messageSurface: "#e4e4e7",
    messageAction: "#4f46e5",
  },
  dark: {
    sidebar: "#0f0f10",
    canvas: "#0a0a0a",
    surface: "#121212",
    accentSurface: "#27272a",
    accent: "#1c1c1f",
    messageSurface: "#27272a",
    messageAction: "#8b9cff",
  },
};

export const STANDARD_THEME_CARDS: ReadonlyArray<ThemeCardDefinition> = [
  {
    id: "default",
    label: "T3 Code",
    previews: (["light", "dark"] as const).map((mode) => ({
      mode,
      colors: STANDARD_THEME_PREVIEW_COLORS[mode],
    })),
  },
];

export function previewColorsOf(
  card: ThemeCardDefinition,
  mode: ThemeAppearance,
): ThemeCardPreviewColors | null {
  return card.previews.find((preview) => preview.mode === mode)?.colors ?? null;
}

export function getThemeCardDefinition(theme: ThemeDefinition): ThemeCardDefinition {
  return {
    id: theme.id,
    label: theme.label,
    previews: getThemeModes(theme).map((mode) => {
      const colors = getThemeColorsForMode(theme, mode) ?? theme.colors;
      return {
        mode,
        colors: {
          sidebar: colors.sidebar,
          canvas: colors.canvas,
          surface: colors.surface,
          accentSurface: colors.accentSurface,
          accent: colors.accent,
          messageSurface: colors.messageSurface,
          messageAction: colors.messageAction,
        },
      };
    }),
  };
}

// Interpolating in oklab keeps the glow falloff perceptually even (no gray
// mid-tones or banding rings), and premultiplied alpha keeps the fade to
// transparent clean.
function getThemePreviewStyle(
  colors: ThemeCardPreviewColors,
  mode: ThemeAppearance,
): CSSProperties {
  const isDark = mode === "dark";
  // The canvas carries the ball's light/dark identity, so it stays dominant:
  // a near-true base with a contained accent glow, instead of an accent wash
  // that makes both modes read alike.
  const modeBase = isDark
    ? `color-mix(in oklab, ${colors.canvas} 80%, #09090b)`
    : `color-mix(in oklab, ${colors.canvas} 80%, #ffffff)`;
  const accentPosition = isDark ? "28% 78%" : "72% 22%";
  const actionPosition = isDark ? "82% 18%" : "18% 82%";
  const accentFade = isDark ? 62 : 72;
  return {
    backgroundColor: modeBase,
    backgroundImage: [
      `radial-gradient(circle at ${accentPosition} in oklab, ${colors.accent} 0%, color-mix(in oklab, ${colors.accent} ${accentFade}%, transparent) 28%, transparent 58%)`,
      // The action color is a soft tint from the opposite corner, not a second
      // light source — two bright hotspots read as headlights.
      `radial-gradient(circle at ${actionPosition} in oklab, color-mix(in oklab, ${colors.messageAction} 45%, transparent) 0%, transparent 55%)`,
    ].join(", "),
  };
}

// The gradient halves of each ball can match the card surface, so every ball
// carries a faint mode-appropriate inner ring to keep its silhouette legible.
function themePreviewEdgeShadow(mode: ThemeAppearance): string {
  return mode === "dark"
    ? "inset 0 0 0 1px rgb(255 255 255 / 0.14), 0 1px 2px rgb(0 0 0 / 0.18)"
    : "inset 0 0 0 1px rgb(0 0 0 / 0.10), 0 1px 2px rgb(0 0 0 / 0.08)";
}

export function ThemePreviewCircle({
  colors,
  mode,
}: {
  colors: ThemeCardPreviewColors;
  mode: ThemeAppearance;
}) {
  return (
    <span
      aria-hidden
      className="relative block size-14 shrink-0 overflow-hidden rounded-full border-2 border-background"
      style={{ boxShadow: themePreviewEdgeShadow(mode) }}
    >
      <span
        className="absolute inset-0 scale-110 rounded-full blur-[3px]"
        style={getThemePreviewStyle(colors, mode)}
      />
    </span>
  );
}

/**
 * A theme card's light and dark balls. Clicking a ball assigns that theme to
 * that half of the appearance mix; assigned balls carry a ring and a sun or
 * moon badge.
 */
export function ThemePreviewCircles({
  label,
  activeModes,
  onSelectMode,
  previews,
}: {
  label: string;
  activeModes: ReadonlyArray<ThemeMode>;
  onSelectMode: (mode: ThemeMode) => void;
  previews: ThemeCardDefinition["previews"];
}) {
  return (
    <div className="flex min-h-16 items-center justify-center gap-2.5 px-3 pt-3">
      {previews.map((preview) => {
        const mode = preview.mode;
        const isPicked = activeModes.includes(mode);
        return (
          <Tooltip key={mode}>
            <TooltipTrigger
              render={
                <button
                  aria-label={`Use ${label} ${mode} mode`}
                  aria-pressed={isPicked}
                  className={cn(
                    "relative flex size-[68px] shrink-0 transform-gpu cursor-pointer items-center justify-center rounded-full p-1 outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                    isPicked && "hover:scale-100",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectMode(mode);
                  }}
                  type="button"
                >
                  <ThemePreviewCircle colors={preview.colors} mode={mode} />
                  {isPicked ? (
                    <>
                      <span
                        aria-hidden
                        className="pointer-events-none absolute inset-0 rounded-full"
                        style={{ boxShadow: "inset 0 0 0 2px var(--ring)" }}
                      />
                      <span
                        aria-hidden
                        className="pointer-events-none absolute bottom-0.5 right-0.5 flex size-5 items-center justify-center rounded-full border border-border/70 bg-background text-foreground shadow-sm"
                      >
                        {mode === "light" ? (
                          <SunIcon className="size-3" />
                        ) : (
                          <MoonIcon className="size-3" />
                        )}
                      </span>
                    </>
                  ) : null}
                </button>
              }
            />
            <TooltipPopup>
              {mode === "light" ? "Use for light mode only" : "Use for dark mode only"}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
