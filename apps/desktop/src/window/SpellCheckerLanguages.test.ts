import { describe, expect, it } from "vite-plus/test";

import { resolveSpellCheckerLanguages } from "./SpellCheckerLanguages.ts";

const AVAILABLE = ["de-DE", "en-AU", "en-GB", "en-US", "fr", "pt-BR", "pt-PT"];

describe("resolveSpellCheckerLanguages", () => {
  it("replaces the packaged en-US default with the OS language", () => {
    expect(resolveSpellCheckerLanguages(["en-US"], ["en-GB"], AVAILABLE)).toEqual(["en-GB"]);
  });

  it("keeps every preferred OS language in order", () => {
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
