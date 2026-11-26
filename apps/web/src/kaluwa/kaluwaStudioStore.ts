// Fork: the theme studio's design records, stored per device in localStorage beside the app's
// theme library. kaluwaLook.ts reads a studio theme's preset (palette base, radii, font) from here.
import { useSyncExternalStore } from "react";

import type { KaluwaPreset } from "./kaluwaPalette";
import {
  parseStudioLibrary,
  serializeStudioLibrary,
  studioPreset,
  type KaluwaStudioTheme,
} from "./kaluwaStudio";

const STORAGE_KEY = "kaluwa:studio:v1";

const listeners = new Set<() => void>();
let themes: ReadonlyArray<KaluwaStudioTheme> | null = null;
const presets = new WeakMap<KaluwaStudioTheme, KaluwaPreset>();
let watchingStorage = false;

function read(): ReadonlyArray<KaluwaStudioTheme> {
  if (themes !== null) return themes;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {}
  themes = parseStudioLibrary(raw);
  return themes;
}

function publish(next: ReadonlyArray<KaluwaStudioTheme>): void {
  themes = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeStudioLibrary(next));
  } catch {
    // Kept for this session only.
  }
  for (const listener of listeners) listener();
}

export function getKaluwaStudioThemes(): ReadonlyArray<KaluwaStudioTheme> {
  return typeof window === "undefined" ? [] : read();
}

export function getKaluwaStudioTheme(id: string | null | undefined): KaluwaStudioTheme | null {
  if (!id) return null;
  return getKaluwaStudioThemes().find((theme) => theme.id === id) ?? null;
}

/** Adds the theme, or replaces the one with its id in place. */
export function saveKaluwaStudioTheme(theme: KaluwaStudioTheme): void {
  const current = read();
  const index = current.findIndex((existing) => existing.id === theme.id);
  publish(
    index === -1
      ? [...current, theme]
      : current.map((existing, at) => (at === index ? theme : existing)),
  );
}

export function removeKaluwaStudioTheme(id: string): void {
  publish(read().filter((theme) => theme.id !== id));
}

/** The preset a studio theme paints with, or null when the id is not a studio theme. */
export function kaluwaStudioPresetForThemeId(
  themeId: string | null | undefined,
): KaluwaPreset | null {
  const theme = getKaluwaStudioTheme(themeId);
  if (theme === null) return null;
  let preset = presets.get(theme);
  if (preset === undefined) {
    preset = studioPreset(theme);
    presets.set(theme, preset);
  }
  return preset;
}

export function subscribeKaluwaStudio(listener: () => void): () => void {
  if (!watchingStorage && typeof window !== "undefined") {
    watchingStorage = true;
    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      themes = null;
      for (const current of listeners) current();
    });
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const EMPTY: ReadonlyArray<KaluwaStudioTheme> = [];

export function useKaluwaStudioThemes(): ReadonlyArray<KaluwaStudioTheme> {
  return useSyncExternalStore(subscribeKaluwaStudio, getKaluwaStudioThemes, () => EMPTY);
}
