import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  normalizeProviderAccentColor,
  providerAccentForegroundColor,
  providerInstanceInitials,
  providerInstanceInitialsGlyphScale,
  resolveProviderInstanceBadgeLabel,
  shouldShowInstanceBadge,
} from "./providerInstanceDisplay.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const acpRegistry = ProviderDriverKind.make("acpRegistry");

describe("providerInstanceInitials", () => {
  it("treats punctuation as a word break but keeps apostrophes between letters", () => {
    expect(providerInstanceInitials("Codex (hub)")).toBe("CH");
    expect(providerInstanceInitials("work_codex")).toBe("WC");
    expect(providerInstanceInitials("Theo's Codex")).toBe("TC");
    expect(providerInstanceInitials("Codex 'hub'")).toBe("CH");
    expect(providerInstanceInitials("‘hub’")).toBe("HU");
    expect(providerInstanceInitials("(hub)")).toBe("HU");
  });

  it("keeps an emoji whole instead of splitting its surrogate pair", () => {
    expect(providerInstanceInitials("😀 Work")).toBe("😀W");
    expect(providerInstanceInitials("😀")).toBe("😀");
  });
});

describe("resolveProviderInstanceBadgeLabel", () => {
  it("falls back to the display name's initials", () => {
    expect(resolveProviderInstanceBadgeLabel({ displayName: "Z.ai GLM" })).toBe("ZG");
    expect(resolveProviderInstanceBadgeLabel({ displayName: "Kimi", badgeLabel: "  " })).toBe("KI");
  });

  it("uses a configured label verbatim, clipped by code point", () => {
    expect(resolveProviderInstanceBadgeLabel({ displayName: "Kimi", badgeLabel: "K2" })).toBe("K2");
    expect(resolveProviderInstanceBadgeLabel({ displayName: "Kimi", badgeLabel: "glm-4" })).toBe(
      "glm",
    );
    expect(resolveProviderInstanceBadgeLabel({ displayName: "Kimi", badgeLabel: "🌙🌙🌙🌙" })).toBe(
      "🌙🌙🌙",
    );
  });
});

describe("providerInstanceInitialsGlyphScale", () => {
  it("shrinks the glyph text as the label grows", () => {
    expect(providerInstanceInitialsGlyphScale("Z")).toBeGreaterThan(
      providerInstanceInitialsGlyphScale("KI"),
    );
    expect(providerInstanceInitialsGlyphScale("KI")).toBeGreaterThan(
      providerInstanceInitialsGlyphScale("KIM"),
    );
    expect(providerInstanceInitialsGlyphScale("🌙")).toBe(providerInstanceInitialsGlyphScale("Z"));
  });
});

describe("normalizeProviderAccentColor", () => {
  // regression: #9899 a non-hex accent must not render as the account badge color
  it("rejects a non-hex value", () => {
    expect(normalizeProviderAccentColor("blue")).toBeUndefined();
  });
});

describe("providerAccentForegroundColor", () => {
  it.each([
    ["#b5f23d", "#000000"],
    ["#2563eb", "#ffffff"],
    ["#777777", "#000000"],
  ])("chooses the higher WCAG contrast foreground for %s", (accent, foreground) => {
    expect(providerAccentForegroundColor(accent)).toBe(foreground);
  });
});

describe("shouldShowInstanceBadge", () => {
  it("hides badges for distinct ACP agents sharing the registry driver", () => {
    const mistral = { driverKind: acpRegistry, acpRegistryAgentId: "mistral-vibe", enabled: true };
    const devin = { driverKind: acpRegistry, acpRegistryAgentId: "devin", enabled: true };
    expect(shouldShowInstanceBadge(mistral, [mistral, devin])).toBe(false);
    expect(shouldShowInstanceBadge(devin, [mistral, devin])).toBe(false);
  });

  it("distinguishes registry instances whose agent identity is unavailable", () => {
    const entry = { driverKind: acpRegistry, enabled: true };
    expect(shouldShowInstanceBadge(entry, [entry, { ...entry }])).toBe(true);
  });

  it("shows the badge when the entry has an accent color", () => {
    const entry = { driverKind: codex, accentColor: "#ff8800", enabled: true };
    expect(shouldShowInstanceBadge(entry, [entry])).toBe(true);
  });

  it("shows the badge when two entries share a driver, even without an accent", () => {
    const first = { driverKind: codex, accentColor: undefined, enabled: true };
    const second = { driverKind: codex, accentColor: undefined, enabled: true };
    expect(shouldShowInstanceBadge(first, [first, second])).toBe(true);
  });

  it("ignores disabled siblings for enabled instances while distinguishing historical owners", () => {
    const enabled = { driverKind: codex, enabled: true };
    const disabled = { driverKind: codex, enabled: false };

    expect(shouldShowInstanceBadge(enabled, [enabled, disabled])).toBe(false);
    expect(shouldShowInstanceBadge(disabled, [enabled, disabled])).toBe(true);
    expect(shouldShowInstanceBadge(disabled, [disabled, { ...disabled }])).toBe(true);
    expect(shouldShowInstanceBadge(disabled, [disabled])).toBe(false);
  });

  it("shows the badge when the entry has a badge label", () => {
    const entry = { driverKind: claude, enabled: true, badgeLabel: "KI" };
    expect(shouldShowInstanceBadge(entry, [entry])).toBe(true);
  });

  it("compares chosen glyphs rather than drivers", () => {
    const claudeLogo = { driverKind: claude, enabled: true };
    const openAiLogo = { driverKind: claude, enabled: true, icon: "codex" };
    const codexDefault = { driverKind: codex, enabled: true };
    expect(shouldShowInstanceBadge(claudeLogo, [claudeLogo, openAiLogo])).toBe(false);
    expect(shouldShowInstanceBadge(openAiLogo, [claudeLogo, openAiLogo, codexDefault])).toBe(true);
  });

  it("ignores disabled accounts sharing a chosen logo for an enabled instance", () => {
    const enabled = { driverKind: claude, icon: "codex", enabled: true };
    const disabled = { driverKind: codex, enabled: false };
    expect(shouldShowInstanceBadge(enabled, [enabled, disabled])).toBe(false);
    expect(shouldShowInstanceBadge(disabled, [enabled, disabled])).toBe(true);
  });

  it("treats an unknown chosen icon as the driver glyph it falls back to", () => {
    const claudeDefault = { driverKind: claude, enabled: true };
    const futureLogo = { driverKind: claude, enabled: true, icon: "future-logo" };
    expect(shouldShowInstanceBadge(futureLogo, [claudeDefault, futureLogo])).toBe(true);
  });

  it("never badges an initials glyph, which already shows the label", () => {
    const entry = { driverKind: claude, enabled: true, icon: "initials", accentColor: "#ff8800" };
    expect(shouldShowInstanceBadge(entry, [entry, { ...entry }])).toBe(false);
  });

  it("does not count an initials glyph as sharing its driver's logo", () => {
    const claudeLogo = { driverKind: claude, enabled: true };
    const initials = { driverKind: claude, enabled: true, icon: "initials" };
    expect(shouldShowInstanceBadge(claudeLogo, [claudeLogo, initials])).toBe(false);
  });
});
