import { expect, it } from "vite-plus/test";

import { localeDirection, resolveLocale } from "./locales.ts";

it.each([
  { language: "he", system: ["en-US"], locale: "he", direction: "rtl" },
  { language: "system", system: ["he-IL", "en-US"], locale: "he", direction: "rtl" },
  { language: "system", system: ["he_IL"], locale: "he", direction: "rtl" },
  { language: "en", system: ["he-IL"], locale: "en", direction: "ltr" },
  { language: "de", system: ["he-IL"], locale: "de", direction: "ltr" },
  { language: "unsupported", system: ["fr-FR", "he-IL"], locale: "he", direction: "rtl" },
  { language: "system", system: ["fr-FR"], locale: "en", direction: "ltr" },
])("resolves $language with system languages $system to $locale ($direction)", (input) => {
  const locale = resolveLocale(input.language, input.system, ["en", "de", "he"], "en");
  expect(locale).toBe(input.locale);
  expect(localeDirection(locale)).toBe(input.direction);
});

it.each([
  ["he", "rtl"],
  ["HE_il", "rtl"],
  ["iw-IL", "rtl"],
  ["ar-EG", "rtl"],
  ["az-Arab", "rtl"],
  ["pa-PK", "rtl"],
  ["pa-IN", "ltr"],
  ["he-Latn", "ltr"],
  ["en", "ltr"],
  ["system", "ltr"],
  ["", "ltr"],
  ["not a locale", "ltr"],
] as const)("resolves layout direction of %s as %s", (locale, expected) => {
  expect(localeDirection(locale)).toBe(expected);
});
