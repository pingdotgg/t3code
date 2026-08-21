import { describe, expect, it } from "vite-plus/test";

import {
  applySpellCheckerSession,
  keyboardLayoutsFromConfig,
  keyboardLayoutsFromEnvironment,
  matchAvailableSpellcheckLanguage,
  normalizeLocaleTag,
  parseXkbLayouts,
  preferredSpellcheckLanguages,
  resolveSpellCheckerLanguages,
  spellcheckSettingsEqual,
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
  it("splits layout lists and preserves inline or paired variants", () => {
    expect(parseXkbLayouts("us,br", ",abnt2")).toEqual([
      { layout: "us" },
      { layout: "br", variant: "abnt2" },
    ]);
    expect(parseXkbLayouts("ch(fr)")).toEqual([{ layout: "ch", variant: "fr" }]);
    expect(parseXkbLayouts("us+intl")).toEqual([{ layout: "us", variant: "intl" }]);
  });
});

describe("keyboard layout discovery", () => {
  it("reads vconsole and Debian keyboard assignments with shell quoting and comments", () => {
    expect(
      keyboardLayoutsFromConfig(
        [
          "# comment",
          "XKBLAYOUT='ch,ca' # active layouts",
          'XKBVARIANT="fr,fr-dvorak"',
          "KEYMAP='br-abnt2' # console layout",
        ].join("\n"),
      ),
    ).toEqual([
      { layout: "ch", variant: "fr" },
      { layout: "ca", variant: "fr-dvorak" },
      { layout: "br", variant: "abnt2" },
    ]);
  });

  it("pairs XKB environment layouts with their variants", () => {
    expect(
      keyboardLayoutsFromEnvironment({
        XKB_DEFAULT_LAYOUT: "us,ch",
        XKB_DEFAULT_VARIANT: ",fr",
      }),
    ).toEqual([{ layout: "us" }, { layout: "ch", variant: "fr" }]);
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
    ).toEqual(["pt-BR", "en-US"]);
  });

  it("reads both Linux keyboard configuration formats when the environment has no layout", () => {
    expect(
      preferredSpellcheckLanguages({
        systemLocale: "en-US",
        env: { LANG: "en_US.UTF-8" },
        configuredLanguages: [],
        keyboardConfigs: ["KEYMAP=us\n", 'XKBLAYOUT="br"\n'],
      }),
    ).toEqual(["en-US", "pt-BR"]);
  });

  it("uses language-bearing XKB variants before the base layout", () => {
    expect(
      preferredSpellcheckLanguages({
        systemLocale: "de-CH",
        env: { XKB_DEFAULT_LAYOUT: "ch,ca", XKB_DEFAULT_VARIANT: "fr,fr-dvorak" },
        configuredLanguages: [],
      }),
    ).toEqual(["fr", "de-CH"]);
  });

  it("includes OS preferred languages on platforms without XKB", () => {
    expect(
      preferredSpellcheckLanguages({
        systemLocale: "en-US",
        preferredSystemLanguages: ["pt_BR", "en-US"],
        env: {},
        configuredLanguages: [],
      }),
    ).toEqual(["pt-BR", "en-US"]);
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

  it("does not truncate a user-selected language list", () => {
    const preferred = AVAILABLE.slice(0, 12);
    expect(resolveSpellCheckerLanguages({ available: AVAILABLE, preferred })).toEqual(preferred);
  });
});

describe("spellcheckSettingsEqual", () => {
  it("only considers the spellcheck settings and preserves language order", () => {
    const defaults = { spellcheckEnabled: true, spellcheckLanguages: ["en-US", "pt-BR"] };
    expect(spellcheckSettingsEqual(defaults, { ...defaults })).toBe(true);
    expect(
      spellcheckSettingsEqual(defaults, {
        spellcheckEnabled: true,
        spellcheckLanguages: ["pt-BR", "en-US"],
      }),
    ).toBe(false);
    expect(
      spellcheckSettingsEqual(defaults, {
        spellcheckEnabled: false,
        spellcheckLanguages: defaults.spellcheckLanguages,
      }),
    ).toBe(false);
  });
});

describe("applySpellCheckerSession", () => {
  it("enables Hunspell for the OS locale and keyboard", () => {
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
      platform: "linux",
      configuredLanguages: [],
      systemLocale: "en-US",
      env: { LANG: "en_US.UTF-8", XKBLAYOUT: "br" },
    });

    expect(enabled).toBe(true);
    expect(result).toEqual({ enabled: true, languages: ["pt-BR", "en-US"] });
    expect(applied).toEqual(["pt-BR", "en-US"]);
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
        platform: "linux",
        configuredLanguages: ["pt-BR"],
        systemLocale: "en-US",
        env: {},
      }),
    ).toEqual({ enabled: false, languages: [] });
    expect(enabled).toBe(false);
  });

  it("disables Hunspell instead of allowing Electron's en-US fallback", () => {
    const setSpellCheckerLanguages = () => {
      throw new Error("empty language lists fall back to en-US in Electron");
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
        enabled: true,
        platform: "linux",
        configuredLanguages: [],
        systemLocale: "C",
        env: {},
      }),
    ).toEqual({ enabled: false, languages: [] });
    expect(enabled).toBe(false);
  });

  it("keeps the fallback disabled when replacing dictionaries fails", () => {
    const enabledCalls: boolean[] = [];
    const session = {
      availableSpellCheckerLanguages: AVAILABLE,
      getSpellCheckerLanguages: () => ["en-US"],
      setSpellCheckerLanguages: () => {
        throw new Error("dictionary update failed");
      },
      setSpellCheckerEnabled: (value: boolean) => {
        enabledCalls.push(value);
      },
    };

    expect(() =>
      applySpellCheckerSession(session, {
        enabled: true,
        platform: "linux",
        configuredLanguages: ["pt-BR"],
        systemLocale: "",
        env: {},
      }),
    ).toThrow("dictionary update failed");
    expect(enabledCalls).toEqual([false]);
  });

  it("lets the native macOS checker choose its own languages", () => {
    let enabled: boolean | undefined;
    const session = {
      availableSpellCheckerLanguages: AVAILABLE,
      getSpellCheckerLanguages: () => ["pt-BR", "en-US"],
      setSpellCheckerLanguages: () => {
        throw new Error("setSpellCheckerLanguages is a no-op on macOS");
      },
      setSpellCheckerEnabled: (value: boolean) => {
        enabled = value;
      },
    };

    expect(
      applySpellCheckerSession(session, {
        enabled: true,
        platform: "darwin",
        configuredLanguages: ["fr"],
        systemLocale: "",
        env: {},
      }),
    ).toEqual({ enabled: true, languages: ["pt-BR", "en-US"] });
    expect(enabled).toBe(true);
  });
});
