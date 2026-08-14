import { sha256 } from "@noble/hashes/sha2";
import {
  registerCustomTheme,
  type DiffsThemeNames,
  type ThemeRegistrationResolved,
} from "@pierre/diffs";

import type { ThemeAppearance, ThemeSyntax } from "../themePalette";
import { resolveDiffThemeName } from "./diffRendering";

const registeredSyntaxThemes = new Set<string>();
const syntaxThemeNameCache = new WeakMap<ThemeSyntax, Map<string, string>>();

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function syntaxThemeName(input: {
  appearance: ThemeAppearance;
  background: string;
  foreground: string;
  syntax: ThemeSyntax;
}) {
  const cacheKey = `${input.appearance}\0${input.background}\0${input.foreground}`;
  const cached = syntaxThemeNameCache.get(input.syntax)?.get(cacheKey);
  if (cached) return cached;

  const serialized = stableStringify(input);
  const digest = [...sha256(new TextEncoder().encode(serialized))]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const name = `t3-syntax-${input.appearance}-${digest}`;
  const names = syntaxThemeNameCache.get(input.syntax) ?? new Map<string, string>();
  names.set(cacheKey, name);
  syntaxThemeNameCache.set(input.syntax, names);
  return name;
}

export function resolveSyntaxThemeName(input: {
  appearance: ThemeAppearance;
  background: string;
  foreground: string;
  label?: string;
  syntax?: ThemeSyntax;
}): DiffsThemeNames {
  if (!input.syntax || input.syntax.tokenColors.length === 0) {
    return resolveDiffThemeName(input.appearance);
  }

  const name = syntaxThemeName({
    appearance: input.appearance,
    background: input.background,
    foreground: input.foreground,
    syntax: input.syntax,
  });
  if (registeredSyntaxThemes.has(name)) return name;

  const settings: ThemeRegistrationResolved["settings"] = input.syntax.tokenColors.map((rule) => ({
    ...(rule.name ? { name: rule.name } : {}),
    ...(rule.scope ? { scope: typeof rule.scope === "string" ? rule.scope : [...rule.scope] } : {}),
    settings: { ...rule.settings },
  }));
  const theme: ThemeRegistrationResolved = {
    name,
    displayName: input.label ?? "Custom theme",
    type: input.appearance,
    fg: input.foreground,
    bg: input.background,
    colors: {
      "editor.foreground": input.foreground,
      "editor.background": input.background,
    },
    settings,
    tokenColors: settings,
  };
  registerCustomTheme(name, async () => theme);
  registeredSyntaxThemes.add(name);
  return name;
}
