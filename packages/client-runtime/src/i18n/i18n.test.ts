import { describe, expect, it } from "vite-plus/test";
import { LanguagePreference } from "@t3tools/contracts/settings";

import { createI18n } from "./createI18n.ts";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_LABELS,
  SUPPORTED_LANGUAGES,
  resolveLanguage,
} from "./languages.ts";
import { resources } from "./resources.ts";

/**
 * The preference schema and the catalogs are declared in separate packages, so
 * nothing but these tests keeps them in step. Each direction of drift breaks a
 * different user-visible thing.
 */
describe("preference and catalog agreement", () => {
  it("ships a catalog for every selectable language", () => {
    const selectable = LanguagePreference.literals.filter((value) => value !== "system");
    for (const language of selectable) {
      // A selectable language with no catalog would fall back to English for
      // every key, so the picker would appear not to work.
      expect(Object.keys(resources)).toContain(language);
    }
  });

  it("offers every shipped language in the picker", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      // A catalog nobody can select is dead weight, and usually a sign that the
      // schema update was forgotten.
      expect(LanguagePreference.literals).toContain(language);
    }
  });
});

describe("resolveLanguage", () => {
  it("honours an explicit preference regardless of the host", () => {
    expect(resolveLanguage("zh", ["en-US"])).toBe("zh");
    expect(resolveLanguage("en", ["zh-Hans-CN"])).toBe("en");
  });

  it("matches the host by primary subtag", () => {
    expect(resolveLanguage("system", ["zh-Hans-CN"])).toBe("zh");
    expect(resolveLanguage("system", ["zh-TW"])).toBe("zh");
    expect(resolveLanguage("system", ["en-GB"])).toBe("en");
  });

  it("takes the first host locale we ship", () => {
    expect(resolveLanguage("system", ["ja-JP", "zh-CN", "en-US"])).toBe("zh");
  });

  it("falls back to the source language when the host is not shipped", () => {
    expect(resolveLanguage("system", ["ja-JP"])).toBe("en");
    expect(resolveLanguage("system", [])).toBe("en");
    expect(resolveLanguage("system")).toBe("en");
  });

  it("tolerates malformed host locales", () => {
    expect(resolveLanguage("system", ["", "  ", "-", "zh"])).toBe("zh");
  });
});

describe("language metadata", () => {
  it("labels every supported language", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      expect(LANGUAGE_LABELS[language]).toBeTruthy();
    }
  });

  it("ships the source language", () => {
    expect(SUPPORTED_LANGUAGES).toContain(DEFAULT_LANGUAGE);
  });
});

describe("createI18n", () => {
  it("translates a plain message", () => {
    const i18n = createI18n();
    expect(i18n.t("wizard.continue")).toBe("Continue");
  });

  it("interpolates named values", () => {
    const i18n = createI18n();
    expect(i18n.t("wizard.agents.terminalLabel", { driver: "Codex" })).toBe("Install Codex");
  });

  it("selects the English plural form", () => {
    const i18n = createI18n({ lng: "en" });
    expect(i18n.t("wizard.import.skipped", { count: 1 })).toBe("1 thread could not be imported.");
    expect(i18n.t("wizard.import.skipped", { count: 2 })).toBe("2 threads could not be imported.");
    expect(i18n.t("wizard.projects.importCount", { count: 1 })).toBe("Import 1 project");
    expect(i18n.t("wizard.projects.importCount", { count: 3 })).toBe("Import 3 projects");
  });

  it("is usable synchronously, before any render", () => {
    // `initAsync: false` is what makes this true; a raw key here would mean the
    // first frame of a fresh client flashes untranslated text.
    const i18n = createI18n();
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.t("wizard.header.title")).toBe("Set up T3 Code");
  });

  it("translates the Chinese catalog and uses one form for every count", () => {
    const i18n = createI18n({ lng: "zh" });
    expect(i18n.t("wizard.continue")).toBe("继续");
    expect(i18n.t("wizard.projects.importCount", { count: 1 })).toBe("导入 1 个项目");
    expect(i18n.t("wizard.projects.importCount", { count: 5 })).toBe("导入 5 个项目");
  });

  it("falls back to English for keys the Chinese catalog omits", () => {
    const i18n = createI18n({ lng: "zh" });
    // Deliberately absent from `zh`: a partial catalog must never surface keys.
    expect(i18n.t("wizard.agents.connectTitle")).not.toBe("wizard.agents.connectTitle");
  });

  it("falls back to the key itself for a message no catalog has", () => {
    const i18n = createI18n();
    expect(i18n.t("wizard.not.a.real.key")).toBe("wizard.not.a.real.key");
  });

  it("switches language at runtime", async () => {
    const i18n = createI18n();
    expect(i18n.t("wizard.continue")).toBe("Continue");
    await i18n.changeLanguage("zh");
    expect(i18n.t("wizard.continue")).toBe("继续");
  });

  it("punctuates the composed warning per language", () => {
    // The wizard joins two messages with a separator message, because Chinese
    // needs its own full stop rather than a Latin period and a space.
    const join = (i18n: ReturnType<typeof createI18n>) =>
      `${i18n.t("wizard.import.imported", { count: 28 })}${i18n.t("wizard.import.sentenceSeparator")}${i18n.t("wizard.import.skipped", { count: 1 })}`;

    expect(join(createI18n({ lng: "en" }))).toBe(
      "Imported 28 threads. 1 thread could not be imported.",
    );
    expect(join(createI18n({ lng: "zh" }))).toBe("已导入 28 条会话。有 1 条会话无法导入。");
  });
});
