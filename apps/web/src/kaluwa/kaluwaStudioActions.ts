// Fork: the theme studio's operations on the app. Each studio theme is installed in the app's
// own theme library, so it shows in the theme picker and command palette and boots without a
// flash; its design record (kaluwaStudioStore.ts) is what the studio edits and rebuilds it from.
import {
  KaluwaSidebarChildAttention,
  KaluwaSidebarFinishedSubagents,
  KaluwaSidebarMachineIndicator,
  KaluwaSidebarSubagents,
} from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import type { ThemeAppearance, ThemeColorRole } from "@t3tools/shared/themePalettes";

import {
  KALUWA_BACKDROP_STORAGE_KEY,
  KaluwaBackdropSettingsSchema,
  defaultBackdropSettings,
  type KaluwaBackdropSettings,
} from "../components/kaluwaBackdrop/backdropSettings";
import { refreshTheme, setTheme } from "../hooks/useTheme";
import { writeLocalStorageValue } from "../hooks/useLocalStorage";
import {
  createVividThemeColors,
  getCustomThemes,
  getThemeColorsForMode,
  getThemeDefinition,
  installCustomTheme,
  removeCustomTheme,
  themeColorToHex,
  toCanonicalThemeColor,
  updateCustomTheme,
} from "../themePalette";
import { parseKaluwaLook, setKaluwaLook, type KaluwaLook } from "./kaluwaLook";
import {
  KALUWA_PRESETS,
  KALUWA_PRESET_IDS,
  type KaluwaPresetId,
  type KaluwaSchemeColors,
} from "./kaluwaPalette";
import {
  createStudioTheme,
  designFromPreset,
  designFromThemeColors,
  studioThemeDefinition,
  uniqueStudioName,
  type KaluwaStudioDesign,
  type KaluwaStudioSettingsRaw,
  type KaluwaStudioTheme,
} from "./kaluwaStudio";
import {
  getKaluwaStudioTheme,
  getKaluwaStudioThemes,
  removeKaluwaStudioTheme,
  saveKaluwaStudioTheme,
} from "./kaluwaStudioStore";
import {
  parseKaluwaTabsSettings,
  updateKaluwaTabsSettings,
  type KaluwaTabsSettings,
} from "./kaluwaTabsSettings";

const BUILDERS = { generate: createVividThemeColors, canonical: toCanonicalThemeColor };

export type KaluwaStudioSidebar = Readonly<{
  kaluwaSidebarMachineIndicator: KaluwaSidebarMachineIndicator;
  kaluwaSidebarSubagents: KaluwaSidebarSubagents;
  kaluwaSidebarFinishedSubagents: KaluwaSidebarFinishedSubagents;
  kaluwaSidebarChildAttention: KaluwaSidebarChildAttention;
}>;

/** Everything a studio theme captures besides its design. */
export type KaluwaStudioSettings = Readonly<{
  look: KaluwaLook;
  tabs: KaluwaTabsSettings;
  backdrop: KaluwaBackdropSettings;
  sidebar: KaluwaStudioSidebar;
}>;

const SidebarSchema = Schema.Struct({
  kaluwaSidebarMachineIndicator: Schema.optionalKey(KaluwaSidebarMachineIndicator),
  kaluwaSidebarSubagents: Schema.optionalKey(KaluwaSidebarSubagents),
  kaluwaSidebarFinishedSubagents: Schema.optionalKey(KaluwaSidebarFinishedSubagents),
  kaluwaSidebarChildAttention: Schema.optionalKey(KaluwaSidebarChildAttention),
});
const decodeSidebar = Schema.decodeUnknownOption(SidebarSchema);
const decodeBackdrop = Schema.decodeUnknownOption(KaluwaBackdropSettingsSchema);

/** The parts of captured settings that still validate; anything else is left as it is. */
export function normalizeStudioSettings(raw: KaluwaStudioSettingsRaw): Partial<{
  look: KaluwaLook;
  tabs: KaluwaTabsSettings;
  backdrop: KaluwaBackdropSettings;
  sidebar: Partial<KaluwaStudioSidebar>;
}> {
  const backdrop = raw.backdrop === undefined ? null : decodeBackdrop(raw.backdrop);
  const sidebar = raw.sidebar === undefined ? null : decodeSidebar(raw.sidebar);
  return {
    ...(raw.look === undefined ? {} : { look: parseKaluwaLook(JSON.stringify(raw.look)) }),
    ...(raw.tabs === undefined ? {} : { tabs: parseKaluwaTabsSettings(JSON.stringify(raw.tabs)) }),
    ...(backdrop?._tag === "Some" ? { backdrop: backdrop.value } : {}),
    ...(sidebar?._tag === "Some" ? { sidebar: sidebar.value } : {}),
  };
}

/** Restores a theme's captured settings. Sidebar options are client settings, written by the caller. */
export function applyStudioSettings(
  raw: KaluwaStudioSettingsRaw,
  writeSidebar: (patch: Partial<KaluwaStudioSidebar>) => void,
): void {
  const settings = normalizeStudioSettings(raw);
  if (settings.look) setKaluwaLook(settings.look);
  if (settings.tabs) updateKaluwaTabsSettings(settings.tabs);
  if (settings.backdrop) {
    writeLocalStorageValue(
      KALUWA_BACKDROP_STORAGE_KEY,
      settings.backdrop,
      defaultBackdropSettings(true),
      KaluwaBackdropSettingsSchema,
    );
  }
  if (settings.sidebar && Object.keys(settings.sidebar).length > 0) writeSidebar(settings.sidebar);
}

function kaluwaPresetIdForThemeId(themeId: string | null): KaluwaPresetId | null {
  if (themeId === null) return "today";
  return KALUWA_PRESET_IDS.find((id) => KALUWA_PRESETS[id].themeId === themeId) ?? null;
}

const ROLE_FOR_KEY: Readonly<
  Record<keyof Omit<KaluwaSchemeColors, "borderAlpha">, ThemeColorRole>
> = {
  bg: "canvas",
  chrome: "chrome",
  sidebar: "sidebar",
  card: "surface",
  composer: "surfaceRaised",
  fg: "text",
  muted: "textMuted",
  accent: "accent",
  accentFg: "accentForeground",
};

/** The design the studio starts from for whatever theme is showing, studio or not. */
export function designForTheme(themeId: string | null): KaluwaStudioDesign {
  const studio = getKaluwaStudioTheme(themeId);
  if (studio) return studio.design;
  const presetId = kaluwaPresetIdForThemeId(themeId);
  if (presetId) return designFromPreset(presetId);
  const definition = themeId ? getThemeDefinition(themeId) : null;
  if (!definition) return designFromPreset("today");
  const colorsFor = (mode: ThemeAppearance) => {
    const roles = getThemeColorsForMode(definition, mode);
    if (!roles) return undefined;
    const colors: Partial<Record<keyof typeof ROLE_FOR_KEY, string>> = {};
    for (const [key, role] of Object.entries(ROLE_FOR_KEY) as Array<
      [keyof typeof ROLE_FOR_KEY, ThemeColorRole]
    >) {
      const hex = themeColorToHex(roles[role])?.slice(0, 7);
      if (hex) colors[key] = hex;
    }
    return colors;
  };
  const dark = colorsFor("dark");
  const light = colorsFor("light");
  return designFromThemeColors(definition.appearance, {
    ...(dark ? { dark } : {}),
    ...(light ? { light } : {}),
  });
}

function takenThemeIds(): ReadonlyArray<string> {
  return getCustomThemes().map((theme) => theme.id);
}

function takenNames(): ReadonlyArray<string> {
  return [
    ...getKaluwaStudioThemes().map((theme) => theme.name),
    ...getCustomThemes().map((theme) => theme.label),
  ];
}

/** Installs a new studio theme and switches to it. Throws when the theme library can't be written. */
export function createAndApplyStudioTheme(input: {
  readonly name: string;
  readonly design: KaluwaStudioDesign;
  readonly settings: KaluwaStudioSettingsRaw;
}): KaluwaStudioTheme {
  const theme = createStudioTheme(
    { ...input, name: uniqueStudioName(input.name, takenNames()) },
    getKaluwaStudioThemes(),
    takenThemeIds(),
  );
  installCustomTheme(studioThemeDefinition(theme, BUILDERS));
  saveKaluwaStudioTheme(theme);
  setTheme(theme.id);
  return theme;
}

let pendingTheme: KaluwaStudioTheme | null = null;
let frame: number | null = null;

function writeThemeDefinition(theme: KaluwaStudioTheme): void {
  const definition = studioThemeDefinition(theme, BUILDERS);
  if (getCustomThemes().some((existing) => existing.id === theme.id)) {
    updateCustomTheme(definition);
  } else {
    // Deleted from the theme library elsewhere; the studio still has it, so put it back.
    installCustomTheme(definition);
  }
  if (document.documentElement.dataset.themeId === theme.id) refreshTheme();
}

/** Rebuilds the app theme after the frame, so a dragged slider writes storage once per frame. */
function scheduleThemeWrite(theme: KaluwaStudioTheme): void {
  pendingTheme = theme;
  if (frame !== null) return;
  frame = window.requestAnimationFrame(() => {
    frame = null;
    const next = pendingTheme;
    pendingTheme = null;
    if (next) {
      try {
        writeThemeDefinition(next);
      } catch (error) {
        console.error("[kaluwa-studio] Could not save the theme.", error);
      }
    }
  });
}

export function updateStudioDesign(id: string, patch: Partial<KaluwaStudioDesign>): void {
  const theme = getKaluwaStudioTheme(id);
  if (!theme) return;
  const next: KaluwaStudioTheme = { ...theme, design: { ...theme.design, ...patch } };
  saveKaluwaStudioTheme(next);
  scheduleThemeWrite(next);
}

export function updateStudioSchemeColors(
  id: string,
  scheme: ThemeAppearance,
  patch: Partial<KaluwaSchemeColors>,
): void {
  const theme = getKaluwaStudioTheme(id);
  if (!theme) return;
  updateStudioDesign(id, { [scheme]: { ...theme.design[scheme], ...patch } });
}

export function recaptureStudioSettings(id: string, settings: KaluwaStudioSettingsRaw): void {
  const theme = getKaluwaStudioTheme(id);
  if (theme) saveKaluwaStudioTheme({ ...theme, settings });
}

/** Renames a studio theme; returns the name it got, which may carry a number to stay unique. */
export function renameStudioTheme(id: string, name: string): string | null {
  const theme = getKaluwaStudioTheme(id);
  if (!theme) return null;
  const others = takenNames().filter((taken) => taken !== theme.name);
  const next: KaluwaStudioTheme = { ...theme, name: uniqueStudioName(name, others) };
  saveKaluwaStudioTheme(next);
  writeThemeDefinition(next);
  return next.name;
}

/** Removes a studio theme from the studio and the theme library. */
export function deleteStudioTheme(id: string): void {
  const theme = getKaluwaStudioTheme(id);
  const active = document.documentElement.dataset.themeId === id;
  if (getCustomThemes().some((existing) => existing.id === id)) removeCustomTheme(id);
  removeKaluwaStudioTheme(id);
  if (active) setTheme(KALUWA_PRESETS[theme?.design.base ?? "ember"].themeId ?? "system");
}

/** Switches to a studio theme and restores what it captured. */
export function applyStudioTheme(
  id: string,
  writeSidebar: (patch: Partial<KaluwaStudioSidebar>) => void,
): boolean {
  const theme = getKaluwaStudioTheme(id);
  if (!theme) return false;
  if (!getCustomThemes().some((existing) => existing.id === id)) writeThemeDefinition(theme);
  if (!setTheme(id)) return false;
  applyStudioSettings(theme.settings, writeSidebar);
  return true;
}
