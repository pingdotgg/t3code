import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as ElectronApp from "./ElectronApp.ts";

const { logWarning } = makeComponentLogger("desktop-spellcheck");

const MAX_SPELLCHECK_LANGUAGES = 8;

const XKB_LAYOUT_TO_SPELLCHECK: Readonly<Record<string, string>> = {
  us: "en-US",
  gb: "en-GB",
  uk: "en-GB",
  ie: "en-GB",
  au: "en-AU",
  ca: "en-CA",
  br: "pt-BR",
  pt: "pt-PT",
  es: "es-ES",
  latam: "es-419",
  fr: "fr",
  be: "fr",
  de: "de-DE",
  at: "de-DE",
  ch: "de-DE",
  it: "it",
  ru: "ru",
  ua: "uk",
  pl: "pl",
  cz: "cs",
  sk: "sk",
  hu: "hu",
  ro: "ro",
  nl: "nl",
  tr: "tr",
  se: "sv",
  dk: "da",
  no: "nb",
  fi: "fi",
  gr: "el",
  il: "he",
  hr: "hr",
  si: "sl",
  bg: "bg",
  ee: "et",
  lv: "lv",
  lt: "lt",
};

export interface SpellCheckerSession {
  readonly availableSpellCheckerLanguages: readonly string[];
  getSpellCheckerLanguages(): string[];
  setSpellCheckerLanguages(languages: string[]): void;
  setSpellCheckerEnabled?(enabled: boolean): void;
}

export function normalizeLocaleTag(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const withoutModifier = trimmed.split("@")[0] ?? trimmed;
  const withoutCharset = withoutModifier.split(".")[0] ?? withoutModifier;
  const tag = withoutCharset.replaceAll("_", "-");
  if (tag.length === 0 || tag === "C" || tag === "POSIX") {
    return undefined;
  }
  return tag;
}

export function parseXkbLayouts(raw: string): string[] {
  const layouts: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const layout = part.trim().toLowerCase().split(/[+(:]/)[0];
    if (layout !== undefined && layout.length > 0) {
      layouts.push(layout);
    }
  }
  return layouts;
}

export function keyboardLayoutsFromVconsole(contents: string): string[] {
  const layouts: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replaceAll('"', "");
    if (key === "XKBLAYOUT") {
      layouts.push(...parseXkbLayouts(value));
      continue;
    }
    if (key === "KEYMAP") {
      const base = value.toLowerCase().split(".")[0]?.split("-")[0];
      if (base !== undefined && base.length > 0) {
        layouts.push(base);
      }
    }
  }
  return layouts;
}

export function keyboardLayoutsFromEnvironment(env: NodeJS.Dict<string>): string[] {
  return [
    ...parseXkbLayouts(env.XKBLAYOUT ?? ""),
    ...parseXkbLayouts(env.XKB_DEFAULT_LAYOUT ?? ""),
  ];
}

export function localeTagsFromEnvironment(env: NodeJS.Dict<string>): string[] {
  const tags: string[] = [];
  const language = env.LANGUAGE;
  if (language !== undefined && language.length > 0) {
    for (const part of language.split(":")) {
      const tag = normalizeLocaleTag(part);
      if (tag !== undefined) {
        tags.push(tag);
      }
    }
  }
  for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"] as const) {
    const tag = normalizeLocaleTag(env[key] ?? "");
    if (tag !== undefined) {
      tags.push(tag);
    }
  }
  return tags;
}

export function matchAvailableSpellcheckLanguage(
  preferred: string,
  available: readonly string[],
): string | undefined {
  if (available.length === 0) {
    return undefined;
  }
  const availableByLower = new Map(available.map((language) => [language.toLowerCase(), language]));
  const preferredLower = preferred.toLowerCase();
  const exact = availableByLower.get(preferredLower);
  if (exact !== undefined) {
    return exact;
  }
  const language = preferredLower.split("-")[0] ?? preferredLower;
  if (preferredLower.includes("-")) {
    const languageOnly = availableByLower.get(language);
    if (languageOnly !== undefined) {
      return languageOnly;
    }
  }
  const regional = available.filter(
    (candidate) =>
      candidate.toLowerCase() === language || candidate.toLowerCase().startsWith(`${language}-`),
  );
  if (regional.length === 0) {
    return undefined;
  }
  const us = regional.find((candidate) => candidate.toLowerCase() === `${language}-us`);
  if (us !== undefined) {
    return us;
  }
  const bare = regional.find((candidate) => candidate.toLowerCase() === language);
  if (bare !== undefined) {
    return bare;
  }
  return regional[0];
}

export function resolveSpellCheckerLanguages(input: {
  readonly available: readonly string[];
  readonly preferred: readonly string[];
}): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const preferred of input.preferred) {
    const matched = matchAvailableSpellcheckLanguage(preferred, input.available);
    if (matched === undefined || seen.has(matched.toLowerCase())) {
      continue;
    }
    seen.add(matched.toLowerCase());
    resolved.push(matched);
    if (resolved.length >= MAX_SPELLCHECK_LANGUAGES) {
      break;
    }
  }
  return resolved;
}

export function preferredSpellcheckLanguages(input: {
  readonly systemLocale: string;
  readonly env: NodeJS.Dict<string>;
  readonly configuredLanguages: readonly string[];
  readonly vconsole?: string;
}): string[] {
  if (input.configuredLanguages.length > 0) {
    return uniquePreferredLanguages(input.configuredLanguages);
  }
  const preferred: string[] = [];
  const systemLocale = normalizeLocaleTag(input.systemLocale);
  if (systemLocale !== undefined) {
    preferred.push(systemLocale);
  }
  preferred.push(...localeTagsFromEnvironment(input.env));
  const layouts = [
    ...keyboardLayoutsFromEnvironment(input.env),
    ...keyboardLayoutsFromVconsole(input.vconsole ?? ""),
  ];
  for (const layout of layouts) {
    const mapped = XKB_LAYOUT_TO_SPELLCHECK[layout];
    if (mapped !== undefined) {
      preferred.push(mapped);
    }
  }
  return uniquePreferredLanguages(preferred);
}

function uniquePreferredLanguages(languages: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const language of languages) {
    const key = language.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(language);
  }
  return unique;
}

export function applySpellCheckerSession(
  session: SpellCheckerSession,
  input: {
    readonly enabled: boolean;
    readonly configuredLanguages: readonly string[];
    readonly systemLocale: string;
    readonly env: NodeJS.Dict<string>;
    readonly vconsole?: string;
  },
): { readonly languages: readonly string[] } {
  session.setSpellCheckerEnabled?.(input.enabled);
  if (!input.enabled) {
    return { languages: [] };
  }
  const languages = resolveSpellCheckerLanguages({
    available: session.availableSpellCheckerLanguages,
    preferred: preferredSpellcheckLanguages(input),
  });
  if (languages.length > 0) {
    session.setSpellCheckerLanguages(languages);
  }
  return { languages };
}

export const syncBrowserWindowSpellChecker = (window: Electron.BrowserWindow) =>
  Effect.gen(function* () {
    if (window.isDestroyed()) {
      return;
    }
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    const electronApp = yield* ElectronApp.ElectronApp;
    const fileSystem = yield* FileSystem.FileSystem;
    const settings = Option.getOrElse(yield* clientSettings.get, () => DEFAULT_CLIENT_SETTINGS);
    const systemLocale = yield* electronApp.systemLocale;
    const vconsole =
      environment.platform === "linux"
        ? yield* fileSystem
            .readFileString("/etc/vconsole.conf")
            .pipe(Effect.orElseSucceed(() => ""))
        : "";
    yield* Effect.try({
      try: () =>
        applySpellCheckerSession(window.webContents.session, {
          enabled: settings.spellcheckEnabled,
          configuredLanguages: settings.spellcheckLanguages,
          systemLocale,
          env: process.env,
          vconsole,
        }),
      catch: (cause) => ({ cause }),
    }).pipe(
      Effect.catch((error) =>
        logWarning("failed to apply composer spell checker languages", { cause: error.cause }),
      ),
    );
  });
