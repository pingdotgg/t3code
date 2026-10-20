// @vitest-environment jsdom

import { describe, expect, it } from "vite-plus/test";

import { applyAppearanceFontVariables, type AppearanceFontPreferences } from "./appearanceFonts";

const preferences: AppearanceFontPreferences = {
  sans: "Arial",
  code: "Menlo",
  composer: "",
  reply: "Source Serif 4",
  sizeInterface: 16,
  sizePrompt: 14,
  sizeCode: 13,
  smoothing: true,
};

describe("reply font appearance", () => {
  it("applies all theme fonts, preserves explicit choices, and clears theme defaults when leaving", () => {
    const root = document.createElement("div");
    const defaults = { ...preferences, sans: "", code: "", reply: "" };
    applyAppearanceFontVariables(root, { ...defaults, typography: "absolutely" });
    expect(root.style.getPropertyValue("--font-sans")).toContain('"DM Sans"');
    expect(root.style.getPropertyValue("--font-mono")).toContain('"JetBrains Mono"');
    expect(root.style.getPropertyValue("--font-reply")).toContain('"Source Serif 4"');
    expect(root.style.getPropertyValue("--font-composer")).toBe("");
    expect(root.style.getPropertyValue("--font-size-reply")).toBe("0.9375rem");
    expect(root.style.getPropertyValue("--font-size-prompt")).toBe("15px");
    expect(root.style.getPropertyValue("--font-size-code")).toBe("14px");
    expect(root.dataset.typography).toBe("absolutely");

    applyAppearanceFontVariables(root, {
      ...preferences,
      typography: "absolutely",
      composer: "Arial",
    });
    expect(root.style.getPropertyValue("--font-sans")).toBe(
      'Arial, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    );
    expect(root.style.getPropertyValue("--font-mono")).toContain("Menlo");
    expect(root.style.getPropertyValue("--font-composer")).toBe("Arial, var(--font-sans)");

    applyAppearanceFontVariables(root, {
      ...defaults,
      typography: "absolutely",
      sizePrompt: 18,
      sizeCode: 16,
    });
    expect(root.style.getPropertyValue("--font-size-prompt")).toBe("18px");
    expect(root.style.getPropertyValue("--font-size-code")).toBe("16px");

    applyAppearanceFontVariables(root, defaults);
    expect(root.dataset.typography).toBeUndefined();
    for (const property of [
      "--font-sans",
      "--font-mono",
      "--font-composer",
      "--font-reply",
      "--font-size-reply",
      "--leading-reply",
      "--font-size-user-message",
      "--leading-user-message",
    ]) {
      expect(root.style.getPropertyValue(property)).toBe("");
    }
  });

  it("follows serif themes, honors an explicit override, and returns to the interface with other themes", () => {
    const root = document.createElement("div");
    applyAppearanceFontVariables(root, { ...preferences, reply: "", typography: "absolutely" });
    expect(root.style.getPropertyValue("--font-reply")).toContain("Georgia, serif");

    applyAppearanceFontVariables(root, {
      ...preferences,
      reply: "Arial",
      typography: "absolutely",
    });
    expect(root.style.getPropertyValue("--font-reply")).toBe("Arial, var(--font-sans)");

    applyAppearanceFontVariables(root, { ...preferences, reply: "" });
    expect(root.style.getPropertyValue("--font-reply")).toBe("");
  });

  it("changes the reply font independently of interface, prompt, and code fonts", () => {
    const root = document.createElement("div");
    applyAppearanceFontVariables(root, preferences);

    const sans = root.style.getPropertyValue("--font-sans");
    const code = root.style.getPropertyValue("--font-mono");
    applyAppearanceFontVariables(root, { ...preferences, reply: "Georgia" });

    expect(root.style.getPropertyValue("--font-reply")).toBe("Georgia, var(--font-sans)");
    expect(root.style.getPropertyValue("--font-sans")).toBe(sans);
    expect(root.style.getPropertyValue("--font-mono")).toBe(code);
    expect(root.style.getPropertyValue("--font-composer")).toBe("");
    expect(root.style.fontSize).toBe("16px");
  });

  it("removes a previous reply override when reset so the interface font can take over", () => {
    const root = document.createElement("div");
    applyAppearanceFontVariables(root, preferences);
    expect(root.style.getPropertyValue("--font-reply")).toContain('"Source Serif 4"');

    applyAppearanceFontVariables(root, { ...preferences, reply: "   " });
    expect(root.style.getPropertyValue("--font-reply")).toBe("");
    expect(root.style.getPropertyValue("--font-sans")).toContain("Arial");
  });
});
