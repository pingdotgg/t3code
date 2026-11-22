import { LocaleConfig } from "@generaltranslation/format";
import { describe, expect, it, vi } from "vite-plus/test";

// Guards patches/@generaltranslation__format@0.1.9.patch: every useGT/useMessages render asks this.
describe("LocaleConfig.requiresTranslation", () => {
  it("answers repeat calls from its cache under gt-i18n's default empty custom mapping", () => {
    const config = new LocaleConfig({
      defaultLocale: "en",
      locales: ["en", "es"],
      customMapping: {},
    });
    expect(config.requiresTranslation("es")).toBe(true);
    expect(config.requiresTranslation("en")).toBe(false);
    using canonicalize = vi.spyOn(Intl, "getCanonicalLocales");
    expect(config.requiresTranslation("es")).toBe(true);
    expect(config.requiresTranslation("en")).toBe(false);
    expect(canonicalize).not.toHaveBeenCalled();
  });
});
