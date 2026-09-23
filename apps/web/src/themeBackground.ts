import type { ThemeBackgroundChoice } from "@t3tools/contracts/settings";
import {
  BUILT_IN_THEME_IDS,
  type ThemeAppearance,
  type ThemeDefinition,
} from "@t3tools/shared/themePalettes";
import { getStandardThemeColors, getThemeColorsForMode } from "./themePalette";

/** Scene art per choice, served from the app's public assets. */
export const THEME_BACKGROUNDS: Readonly<Record<ThemeBackgroundChoice, string>> = {
  auto: "",
  none: "",
  "t3-chat": "/backgrounds/t3-chat.webp",
  grove: "/backgrounds/grove.webp",
  ocean: "/backgrounds/ocean.webp",
  ember: "/backgrounds/ember.webp",
  iris: "/backgrounds/iris.webp",
  alpine: "/backgrounds/alpine.webp",
  aurora: "/backgrounds/aurora.webp",
  coastline: "/backgrounds/coastline.webp",
  dune: "/backgrounds/dune.webp",
  fjord: "/backgrounds/fjord.webp",
  "forest-lake": "/backgrounds/forest-lake.webp",
  highlands: "/backgrounds/highlands.webp",
  meadow: "/backgrounds/meadow.webp",
  nightfall: "/backgrounds/nightfall.webp",
  terraces: "/backgrounds/terraces.webp",
};

/** Standalone scenes that are not tied to a built-in theme. */
export const STANDALONE_SCENE_IDS = [
  "alpine",
  "aurora",
  "coastline",
  "dune",
  "fjord",
  "forest-lake",
  "highlands",
  "meadow",
  "nightfall",
  "terraces",
] as const;

export type StandaloneSceneId = (typeof STANDALONE_SCENE_IDS)[number];

export const THEME_BACKGROUND_LABELS: Readonly<Record<ThemeBackgroundChoice, string>> = {
  auto: "Theme scene",
  none: "None",
  "t3-chat": "T3 Chat",
  grove: "Grove",
  ocean: "Ocean",
  ember: "Ember",
  iris: "Iris",
  alpine: "Alpine",
  aurora: "Aurora",
  coastline: "Coastline",
  dune: "Dune",
  fjord: "Fjord",
  "forest-lake": "Forest Lake",
  highlands: "Highlands",
  meadow: "Meadow",
  nightfall: "Nightfall",
  terraces: "Terraces",
};

/** Options for the settings picker, in display order. */
export const THEME_BACKGROUND_CHOICES: ReadonlyArray<ThemeBackgroundChoice> = [
  "auto",
  "none",
  ...BUILT_IN_THEME_IDS,
  ...STANDALONE_SCENE_IDS,
];

/**
 * Which scene paints behind the interface, if any. "auto" follows the active
 * theme when it is a built-in; a picked scene stays put across theme changes.
 */
export function resolveThemeBackgroundUrl(
  choice: ThemeBackgroundChoice,
  themeId: string | null,
): string | null {
  if (choice === "none") return null;
  const sceneId = choice === "auto" ? themeId : choice;
  if (sceneId === null) return null;
  const url = THEME_BACKGROUNDS[sceneId as ThemeBackgroundChoice];
  return url || null;
}

/**
 * Paint (or clear) the scene layer for the active theme. Tints come straight
 * from the theme definition's solid colors — reading them off the document
 * would race the palette application and go stale when an environment
 * republishes a theme under the same id.
 */
export function applyThemeBackground(
  url: string | null,
  definition: ThemeDefinition | null,
  appearance: ThemeAppearance,
): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root?.style) return;

  delete root.dataset.appBackdrop;
  root.style.removeProperty("--app-backdrop-image");
  root.style.removeProperty("--app-backdrop-tint");
  root.style.removeProperty("--app-backdrop-tint-sidebar");
  root.style.removeProperty("--app-backdrop-tint-toolbar");
  // Restore the stylesheet's body fill (syncBrowserChromeTheme's transparent
  // override below only applies while a scene is active).
  document.body.style.backgroundColor = "";

  if (!url) return;

  const colors = definition
    ? (getThemeColorsForMode(definition, appearance) ?? definition.colors)
    : getStandardThemeColors(appearance);

  root.dataset.appBackdrop = "on";
  root.style.setProperty("--app-backdrop-image", `url("${url}")`);
  root.style.setProperty("--app-backdrop-tint", colors.canvas);
  root.style.setProperty("--app-backdrop-tint-sidebar", colors.sidebar);
  root.style.setProperty("--app-backdrop-tint-toolbar", colors.toolbar);

  // syncBrowserChromeTheme paints an opaque body fill for the browser chrome;
  // the scene layer sits under it, so glass mode keeps the body clear.
  document.body.style.backgroundColor = "transparent";
}
