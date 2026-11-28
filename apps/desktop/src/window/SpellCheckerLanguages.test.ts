import { describe, expect, it } from "vite-plus/test";

import { resolveSpellCheckerLanguages } from "./SpellCheckerLanguages.ts";

// Chromium lists a bare "en" (the en-US dictionary) next to the regional ones.
const AVAILABLE = ["de-DE", "en", "en-AU", "en-GB", "en-US", "fr", "pt-BR", "pt-PT"];

describe("resolveSpellCheckerLanguages", () => {
  it("replaces the packaged en-US default with the OS languages in order", () => {
    expect(resolveSpellCheckerLanguages(["en-US"], ["en-GB", "pt-BR"], AVAILABLE)).toEqual([
      "en-GB",
      "pt-BR",
    ]);
  });

  it("normalizes POSIX locale names", () => {
    expect(resolveSpellCheckerLanguages([], ["en_GB.UTF-8"], AVAILABLE)).toEqual(["en-GB"]);
  });

  it("falls back to a dictionary for the same base language", () => {
    expect(resolveSpellCheckerLanguages(["en-US"], ["fr-CA", "de-AT"], AVAILABLE)).toEqual([
      "fr",
      "de-DE",
    ]);
  });

  it("does not add another regional dictionary for a generic base-language fallback", () => {
    expect(resolveSpellCheckerLanguages(["en-US"], ["en_GB", "en"], AVAILABLE)).toEqual(["en-GB"]);
    expect(resolveSpellCheckerLanguages(["en-US"], ["en", "en-GB"], AVAILABLE)).toEqual(["en-GB"]);
    expect(resolveSpellCheckerLanguages(["en-US"], ["en-GB", "en-US"], AVAILABLE)).toEqual([
      "en-GB",
      "en-US",
    ]);
  });

  it("keeps a list the user already changed", () => {
    expect(resolveSpellCheckerLanguages(["en-AU"], ["en-GB"], AVAILABLE)).toBeUndefined();
    expect(resolveSpellCheckerLanguages(["en-US", "fr"], ["en-GB"], AVAILABLE)).toBeUndefined();
  });

  it("leaves the session alone when nothing changes or matches", () => {
    expect(resolveSpellCheckerLanguages(["en-US"], ["en-US"], AVAILABLE)).toBeUndefined();
    expect(resolveSpellCheckerLanguages(["en-US"], ["tlh"], AVAILABLE)).toBeUndefined();
    expect(resolveSpellCheckerLanguages(["en-US"], [], AVAILABLE)).toBeUndefined();
  });
});
