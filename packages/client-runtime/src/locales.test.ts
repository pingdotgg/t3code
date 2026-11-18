import { describe, expect, it } from "vite-plus/test";

import { resolveLocale } from "./locales.ts";

const SUPPORTED = ["en", "de", "nb", "pt-BR", "sv", "zh"];

describe("resolveLocale", () => {
  it("keeps a saved language the app supports", () => {
    expect(resolveLocale("nb", ["de-DE"], SUPPORTED, "en")).toBe("nb");
  });

  it("matches a system language by its base tag", () => {
    expect(resolveLocale("system", ["nb-NO"], SUPPORTED, "en")).toBe("nb");
    expect(resolveLocale("system", ["sv_SE"], SUPPORTED, "en")).toBe("sv");
  });

  it("treats the Norwegian macrolanguage as Bokmål", () => {
    expect(resolveLocale("system", ["no-NO"], SUPPORTED, "en")).toBe("nb");
    expect(resolveLocale("system", ["no"], SUPPORTED, "en")).toBe("nb");
  });

  it("does not treat Nynorsk as Bokmål", () => {
    expect(resolveLocale("system", ["nn-NO", "de"], SUPPORTED, "en")).toBe("de");
  });

  it("only matches Traditional Chinese exactly", () => {
    expect(resolveLocale("system", ["zh-TW"], SUPPORTED, "en")).toBe("en");
    expect(resolveLocale("system", ["zh-CN"], SUPPORTED, "en")).toBe("zh");
  });
});
