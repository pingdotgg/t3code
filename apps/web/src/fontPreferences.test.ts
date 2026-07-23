import { describe, expect, it } from "vite-plus/test";

import {
  applyFontFamilyPreference,
  matchFontPresetId,
  quoteCssFontFamily,
  resolveFontFamilyCss,
  sanitizeFontFamilyPreference,
} from "./fontPreferences";

describe("fontPreferences", () => {
  it("keeps empty preferences on the bundled default", () => {
    expect(sanitizeFontFamilyPreference("   ")).toBe("");
    expect(resolveFontFamilyCss("", "ui")).toBeNull();
    expect(resolveFontFamilyCss("", "code")).toBeNull();
    expect(matchFontPresetId("", "ui")).toBe("default");
  });

  it("matches presets and treats unknown names as custom", () => {
    expect(matchFontPresetId("Geist", "ui")).toBe("geist");
    expect(matchFontPresetId("Geist Mono", "code")).toBe("geist");
    expect(matchFontPresetId("Berkeley Mono", "code")).toBe("custom");
  });

  it("quotes multi-word families and leaves CSS keywords bare", () => {
    expect(quoteCssFontFamily("system-ui")).toBe("system-ui");
    expect(quoteCssFontFamily("Geist")).toBe("Geist");
    expect(quoteCssFontFamily("Geist Mono")).toBe('"Geist Mono"');
  });

  it("builds a fallback stack for local font names", () => {
    expect(resolveFontFamilyCss("Geist", "ui")).toBe(
      'Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    );
    expect(resolveFontFamilyCss("Geist Mono", "code")).toContain('"Geist Mono"');
  });

  it("rejects unsafe font family input", () => {
    expect(sanitizeFontFamilyPreference('Foo"; background: red')).toBe("");
    expect(sanitizeFontFamilyPreference("url(https://evil.example)")).toBe("");
  });

  it("applies and clears CSS variables on a style target", () => {
    const properties = new Map<string, string>();
    const target = {
      setProperty: (name: string, value: string) => {
        properties.set(name, value);
      },
      removeProperty: (name: string) => {
        properties.delete(name);
      },
    } as CSSStyleDeclaration;

    applyFontFamilyPreference("Geist", "ui", target);
    expect(properties.get("--font-sans")).toContain("Geist");

    applyFontFamilyPreference("", "ui", target);
    expect(properties.has("--font-sans")).toBe(false);
  });
});
