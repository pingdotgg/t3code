import { describe, expect, it } from "vite-plus/test";

import {
  applySpellCheckerSession,
  keyboardLayoutsFromVconsole,
  matchAvailableSpellcheckLanguage,
  normalizeLocaleTag,
  parseXkbLayouts,
  preferredSpellcheckLanguages,
  resolveSpellCheckerLanguages,
} from "./ElectronSpellcheck.ts";

const AVAILABLE = [
  "en-US",
  "en-GB",
  "en-AU",
  "en-CA",
  "pt-BR",
  "pt-PT",
  "es",
  "es-419",
  "es-ES",
  "fr",
  "de-DE",
  "it",
  "nl",
  "pl",
  "ru",
] as const;

describe("normalizeLocaleTag", () => {
  it("turns POSIX locale identifiers into BCP-47 tags", () => {
    expect(normalizeLocaleTag("pt_BR.UTF-8")).toBe("pt-BR");
    expect(normalizeLocaleTag("en_US.utf8@euro")).toBe("en-US");
    expect(normalizeLocaleTag("C")).toBeUndefined();
    expect(normalizeLocaleTag("POSIX")).toBeUndefined();
    expect(normalizeLocaleTag("")).toBeUndefined();
  });
});

describe("parseXkbLayouts", () => {
  it("splits comma lists and strips variants", () => {
    expect(parseXkbLayouts("us,br")).toEqual(["us", "br"]);
    expect(parseXkbLayouts("br(abnt2)")).toEqual(["br"]);
    expect(parseXkbLayouts("us+intl")).toEqual(["us"]);
  });
});

describe("keyboardLayoutsFromVconsole", () => {
  it("reads XKBLAYOUT and KEYMAP", () => {
    expect(
      keyboardLayoutsFromVconsole(["# comment", 'XKBLAYOUT="br"', "KEYMAP=br-abnt2"].join("\n")),
    ).toEqual(["br", "br"]);
  });
});

describe("matchAvailableSpellcheckLanguage", () => {
  it("prefers an exact Hunspell dictionary", () => {
    expect(matchAvailableSpellcheckLanguage("pt-BR", AVAILABLE)).toBe("pt-BR");
    expect(matchAvailableSpellcheckLanguage("fr-FR", AVAILABLE)).toBe("fr");
    expect(matchAvailableSpellcheckLanguage("de", AVAILABLE)).toBe("de-DE");
    expect(matchAvailableSpellcheckLanguage("en", AVAILABLE)).toBe("en-US");
    expect(matchAvailableSpellcheckLanguage("ja", AVAILABLE)).toBeUndefined();
  });
});

describe("preferredSpellcheckLanguages", () => {
  it("uses an explicit language list when the user picked dictionaries", () => {
    expect(
      preferredSpellcheckLanguages({
        systemLocale: "en-US",
        env: { XKBLAYOUT: "br", LANG: "en_US.UTF-8" },
        configuredLanguages: ["pt-BR"],
      }),
    ).toEqual(["pt-BR"]);
  });

  it("adds the keyboard layout when the OS locale is English", () => {
    expect(
      preferredSpellcheckLanguages({
        systemLocale: "en-US",
        env: { LANG: "en_US.UTF-8", XKBLAYOUT: "br" },
        configuredLanguages: [],
      }),
    ).toEqual(["en-US", "pt-BR"]);
  });

  it("reads /etc/vconsole.conf when the process env has no layout", () => {
    expect(
      preferredSpellcheckLanguages({
        systemLocale: "en-US",
        env: { LANG: "en_US.UTF-8" },
        configuredLanguages: [],
        vconsole: "XKBLAYOUT=br\n",
      }),
    ).toEqual(["en-US", "pt-BR"]);
  });

  it("honors LANGUAGE before LANG", () => {
    expect(
      preferredSpellcheckLanguages({
        systemLocale: "en-US",
        env: { LANGUAGE: "pt_BR:en", LANG: "en_US.UTF-8" },
        configuredLanguages: [],
      }),
    ).toEqual(["en-US", "pt-BR", "en"]);
  });
});

describe("resolveSpellCheckerLanguages", () => {
  it("drops tags Chromium cannot download and keeps order", () => {
    expect(
      resolveSpellCheckerLanguages({
        available: AVAILABLE,
        preferred: ["en-US", "pt-BR", "ja", "en-US"],
      }),
    ).toEqual(["en-US", "pt-BR"]);
  });

  it("does not invent en-US when nothing matches", () => {
    expect(
      resolveSpellCheckerLanguages({
        available: AVAILABLE,
        preferred: ["ja", "zh-CN"],
      }),
    ).toEqual([]);
  });
});

describe("applySpellCheckerSession", () => {
  it("enables Hunspell for the OS locale and keyboard without emptying the list", () => {
    const setSpellCheckerLanguages = (languages: string[]) => {
      applied = languages;
    };
    let enabled: boolean | undefined;
    let applied: string[] | undefined;
    const session = {
      availableSpellCheckerLanguages: AVAILABLE,
      getSpellCheckerLanguages: () => ["en-US"],
      setSpellCheckerLanguages,
      setSpellCheckerEnabled: (value: boolean) => {
        enabled = value;
      },
    };

    const result = applySpellCheckerSession(session, {
      enabled: true,
      configuredLanguages: [],
      systemLocale: "en-US",
      env: { LANG: "en_US.UTF-8", XKBLAYOUT: "br" },
    });

    expect(enabled).toBe(true);
    expect(result.languages).toEqual(["en-US", "pt-BR"]);
    expect(applied).toEqual(["en-US", "pt-BR"]);
  });

  it("leaves the current dictionaries alone when turning spellcheck off", () => {
    const setSpellCheckerLanguages = () => {
      throw new Error("should not rewrite dictionaries while disabled");
    };
    let enabled: boolean | undefined;
    const session = {
      availableSpellCheckerLanguages: AVAILABLE,
      getSpellCheckerLanguages: () => ["en-US"],
      setSpellCheckerLanguages,
      setSpellCheckerEnabled: (value: boolean) => {
        enabled = value;
      },
    };

    expect(
      applySpellCheckerSession(session, {
        enabled: false,
        configuredLanguages: ["pt-BR"],
        systemLocale: "en-US",
        env: {},
      }),
    ).toEqual({ languages: [] });
    expect(enabled).toBe(false);
  });

  it("does not call setSpellCheckerLanguages with an empty list", () => {
    const setSpellCheckerLanguages = () => {
      throw new Error("empty language lists fall back to en-US in Electron");
    };
    const session = {
      availableSpellCheckerLanguages: AVAILABLE,
      getSpellCheckerLanguages: () => ["en-US"],
      setSpellCheckerLanguages,
    };

    expect(
      applySpellCheckerSession(session, {
        enabled: true,
        configuredLanguages: [],
        systemLocale: "C",
        env: {},
      }),
    ).toEqual({ languages: [] });
  });
});
