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
  "he",
  "he-IL",
  "HE_il",
  "iw-IL",
  "ar",
  "ar-EG",
  "fa",
  "ur",
  "ps",
  "dv",
  "yi",
  "syr",
  "ckb",
  "sd",
  "ug",
  "ks",
  "pa-PK",
  "az-Arab",
  "ku-Arab",
  "ff-Adlm",
  "nqo",
  "rhg",
  "und-Samr",
  "und-Yezi",
  "und-Gara",
])("uses RTL layout for %s", (locale) => {
  expect(localeDirection(locale)).toBe("rtl");
});

it.each([
  "en",
  "de",
  "zh",
  "he-Latn",
  "ar-Latn",
  "az-Latn",
  "ku",
  "pa-IN",
  "ks-Deva",
  "ff-Latn",
  "system",
  "",
  "not a locale",
])("uses LTR layout for %s", (locale) => {
  expect(localeDirection(locale)).toBe("ltr");
});
