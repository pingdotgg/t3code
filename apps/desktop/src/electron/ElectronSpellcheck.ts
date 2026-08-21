import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as ElectronApp from "./ElectronApp.ts";

const { logWarning } = makeComponentLogger("desktop-spellcheck");

const LINUX_KEYBOARD_CONFIG_PATHS = ["/etc/vconsole.conf", "/etc/default/keyboard"] as const;
const PROCESS_TERMINATE_GRACE = Duration.seconds(1);
const WINDOWS_KEYBOARD_QUERY_TIMEOUT = Duration.seconds(3);
const WINDOWS_KEYBOARD_LANGUAGE_SCRIPT = [
  "try {",
  'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class T3KeyboardLayout { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr processId); [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint threadId); }\' -ErrorAction Stop;',
  "$window = [T3KeyboardLayout]::GetForegroundWindow();",
  "$thread = [T3KeyboardLayout]::GetWindowThreadProcessId($window, [IntPtr]::Zero);",
  "$layout = [T3KeyboardLayout]::GetKeyboardLayout($thread).ToInt64();",
  "$activeLangId = [int]($layout -band 0xffff);",
  "[Globalization.CultureInfo]::GetCultureInfo($activeLangId).Name",
  "} catch {}",
  "Get-WinUserLanguageList | ForEach-Object { $_.InputMethodTips } | ForEach-Object {",
  "try {",
  "$languageId = ($_ -split ':')[0];",
  "if ($languageId -match '^[0-9a-fA-F]{4}$') {",
  "$langId = [Convert]::ToInt32($languageId, 16);",
  "[Globalization.CultureInfo]::GetCultureInfo($langId).Name",
  "}",
  "} catch {}",
  "}",
].join(" ");

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
  setSpellCheckerEnabled(enabled: boolean): void;
}

export interface XkbLayoutPreference {
  readonly layout: string;
  readonly variant?: string;
}

type SpellcheckSettings = Pick<ClientSettings, "spellcheckEnabled" | "spellcheckLanguages">;

export class ElectronSpellcheckApplyError extends Schema.TaggedErrorClass<ElectronSpellcheckApplyError>()(
  "ElectronSpellcheckApplyError",
  {
    enabled: Schema.Boolean,
    platform: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to apply the composer spell checker (enabled: ${this.enabled}, platform: ${this.platform}).`;
  }
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

function splitXkbValues(raw: string): string[] {
  return raw.includes(",") ? raw.split(",") : raw.trim().split(/\s+/);
}

export function parseXkbLayouts(rawLayouts: string, rawVariants = ""): XkbLayoutPreference[] {
  const variants = rawVariants.split(",");
  const layouts: XkbLayoutPreference[] = [];
  for (const [index, part] of splitXkbValues(rawLayouts).entries()) {
    const trimmed = part.trim().toLowerCase();
    if (trimmed.length === 0) continue;
    const combined = /^([^+(:]+)(?:[+(:]([^)]*)\)?)?$/.exec(trimmed);
    const layout = (combined?.[1] ?? trimmed).trim();
    const variant = (combined?.[2] ?? variants[index] ?? "").trim().toLowerCase();
    if (layout.length === 0) continue;
    layouts.push({ layout, ...(variant.length > 0 ? { variant } : {}) });
  }
  return layouts;
}

function parseKeyboardConfigValue(raw: string): string {
  return raw
    .trim()
    .replace(/\s+#.*$/, "")
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2");
}

export function keyboardLayoutsFromConfig(contents: string): XkbLayoutPreference[] {
  const assignments = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    assignments.set(
      trimmed.slice(0, separator).trim(),
      parseKeyboardConfigValue(trimmed.slice(separator + 1)),
    );
  }

  const layouts = parseXkbLayouts(
    assignments.get("XKBLAYOUT") ?? "",
    assignments.get("XKBVARIANT") ?? "",
  );
  const keymap = assignments.get("KEYMAP")?.toLowerCase().split(".")[0];
  if (keymap !== undefined && keymap.length > 0) {
    const [layout, ...variantParts] = keymap.split("-");
    if (layout !== undefined && layout.length > 0) {
      const variant = variantParts.join("-");
      layouts.push({ layout, ...(variant.length > 0 ? { variant } : {}) });
    }
  }
  return layouts;
}

export function keyboardLayoutsFromEnvironment(env: NodeJS.Dict<string>): XkbLayoutPreference[] {
  return [
    ...parseXkbLayouts(env.XKBLAYOUT ?? "", env.XKBVARIANT ?? ""),
    ...parseXkbLayouts(env.XKB_DEFAULT_LAYOUT ?? "", env.XKB_DEFAULT_VARIANT ?? ""),
  ];
}

function spellcheckLanguageForKeyboardLayout(preference: XkbLayoutPreference): string | undefined {
  const variantLanguage = preference.variant?.split(/[-_]/)[0];
  return (
    (variantLanguage === undefined ? undefined : XKB_LAYOUT_TO_SPELLCHECK[variantLanguage]) ??
    XKB_LAYOUT_TO_SPELLCHECK[preference.layout]
  );
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

export function windowsKeyboardLanguageTagsFromOutput(raw: string): string[] {
  const tags: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const tag = normalizeLocaleTag(line);
    if (tag !== undefined) tags.push(tag);
  }
  return uniquePreferredLanguages(tags);
}

export const readWindowsKeyboardLanguageTags = Effect.fn(
  "desktop.spellcheck.readWindowsKeyboardLanguageTags",
)(function* (): Effect.fn.Return<
  readonly string[],
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* spawner
    .string(
      ChildProcess.make(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_KEYBOARD_LANGUAGE_SCRIPT],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: PROCESS_TERMINATE_GRACE,
        },
      ),
    )
    .pipe(
      Effect.timeoutOption(WINDOWS_KEYBOARD_QUERY_TIMEOUT),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
  return Option.match(output, {
    onNone: () => [],
    onSome: windowsKeyboardLanguageTagsFromOutput,
  });
});

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
  readonly requireExact?: boolean;
}): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();
  const availableByLower = input.requireExact
    ? new Map(input.available.map((language) => [language.toLowerCase(), language]))
    : undefined;
  for (const preferred of input.preferred) {
    const matched =
      availableByLower?.get(preferred.toLowerCase()) ??
      (input.requireExact
        ? undefined
        : matchAvailableSpellcheckLanguage(preferred, input.available));
    if (matched === undefined || seen.has(matched.toLowerCase())) continue;
    seen.add(matched.toLowerCase());
    resolved.push(matched);
  }
  return resolved;
}

export function preferredSpellcheckLanguages(input: {
  readonly systemLocale: string;
  readonly preferredSystemLanguages?: readonly string[];
  readonly platformKeyboardLanguages?: readonly string[];
  readonly env: NodeJS.Dict<string>;
  readonly configuredLanguages: readonly string[];
  readonly keyboardConfigs?: readonly string[];
}): string[] {
  if (input.configuredLanguages.length > 0) {
    return uniquePreferredLanguages(input.configuredLanguages);
  }

  const preferred: string[] = [];
  const layouts = [
    ...keyboardLayoutsFromEnvironment(input.env),
    ...(input.keyboardConfigs ?? []).flatMap(keyboardLayoutsFromConfig),
  ];
  for (const layout of layouts) {
    const mapped = spellcheckLanguageForKeyboardLayout(layout);
    if (mapped !== undefined) preferred.push(mapped);
  }
  for (const language of input.platformKeyboardLanguages ?? []) {
    const normalized = normalizeLocaleTag(language);
    if (normalized !== undefined) preferred.push(normalized);
  }
  for (const language of input.preferredSystemLanguages ?? []) {
    const normalized = normalizeLocaleTag(language);
    if (normalized !== undefined) preferred.push(normalized);
  }
  const systemLocale = normalizeLocaleTag(input.systemLocale);
  if (systemLocale !== undefined) preferred.push(systemLocale);
  preferred.push(...localeTagsFromEnvironment(input.env));
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

export function spellcheckSettingsEqual(
  left: SpellcheckSettings,
  right: SpellcheckSettings,
): boolean {
  return (
    left.spellcheckEnabled === right.spellcheckEnabled &&
    left.spellcheckLanguages.length === right.spellcheckLanguages.length &&
    left.spellcheckLanguages.every(
      (language, index) => language === right.spellcheckLanguages[index],
    )
  );
}

export function applySpellCheckerSession(
  session: SpellCheckerSession,
  input: {
    readonly enabled: boolean;
    readonly platform: NodeJS.Platform;
    readonly configuredLanguages: readonly string[];
    readonly systemLocale: string;
    readonly preferredSystemLanguages?: readonly string[];
    readonly platformKeyboardLanguages?: readonly string[];
    readonly env: NodeJS.Dict<string>;
    readonly keyboardConfigs?: readonly string[];
  },
): { readonly enabled: boolean; readonly languages: readonly string[] } {
  if (input.platform === "darwin") {
    session.setSpellCheckerEnabled(input.enabled);
    return {
      enabled: input.enabled,
      languages: input.enabled ? session.getSpellCheckerLanguages() : [],
    };
  }
  if (!input.enabled) {
    session.setSpellCheckerEnabled(false);
    return { enabled: false, languages: [] };
  }

  const languages = resolveSpellCheckerLanguages({
    available: session.availableSpellCheckerLanguages,
    preferred: preferredSpellcheckLanguages(input),
    requireExact: input.configuredLanguages.length > 0,
  });
  if (languages.length === 0) {
    // Electron silently falls back to en-US when its language list is empty.
    // Disable the checker instead of underlining valid text in another language.
    session.setSpellCheckerEnabled(false);
    return { enabled: false, languages };
  }
  // Keep Electron's persisted fallback dictionary inactive until the complete
  // replacement succeeds. A failed update must not leave en-US checking active.
  session.setSpellCheckerEnabled(false);
  session.setSpellCheckerLanguages(languages);
  session.setSpellCheckerEnabled(true);
  return { enabled: true, languages };
}

export const syncBrowserWindowSpellChecker = (
  window: Electron.BrowserWindow,
  settingsOverride?: SpellcheckSettings,
) =>
  Effect.gen(function* () {
    if (window.isDestroyed()) return;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const electronApp = yield* ElectronApp.ElectronApp;
    const fileSystem = yield* FileSystem.FileSystem;

    const settings = yield* Effect.gen(function* () {
      if (settingsOverride !== undefined) return settingsOverride;
      const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
      return Option.getOrElse(yield* clientSettings.get, () => DEFAULT_CLIENT_SETTINGS);
    });

    let systemLocale = "";
    let preferredSystemLanguages: readonly string[] = [];
    let platformKeyboardLanguages: readonly string[] = [];
    let keyboardConfigs: readonly string[] = [];
    const needsAutomaticLanguages =
      settings.spellcheckEnabled &&
      settings.spellcheckLanguages.length === 0 &&
      environment.platform !== "darwin";
    if (needsAutomaticLanguages) {
      systemLocale = yield* electronApp.systemLocale;
      preferredSystemLanguages = yield* electronApp.preferredSystemLanguages;
      if (environment.platform === "linux") {
        keyboardConfigs = yield* Effect.forEach(LINUX_KEYBOARD_CONFIG_PATHS, (path) =>
          fileSystem.readFileString(path).pipe(Effect.orElseSucceed(() => "")),
        );
      } else if (environment.platform === "win32") {
        platformKeyboardLanguages = yield* readWindowsKeyboardLanguageTags();
      }
    }

    yield* Effect.try({
      try: () =>
        applySpellCheckerSession(window.webContents.session, {
          enabled: settings.spellcheckEnabled,
          platform: environment.platform,
          configuredLanguages: settings.spellcheckLanguages,
          systemLocale,
          preferredSystemLanguages,
          platformKeyboardLanguages,
          env: process.env,
          keyboardConfigs,
        }),
      catch: (cause) =>
        new ElectronSpellcheckApplyError({
          enabled: settings.spellcheckEnabled,
          platform: environment.platform,
          cause,
        }),
    }).pipe(
      Effect.catch((error) =>
        logWarning("failed to apply composer spell checker languages", {
          enabled: error.enabled,
          platform: error.platform,
          cause: error.cause,
        }),
      ),
    );
  });
