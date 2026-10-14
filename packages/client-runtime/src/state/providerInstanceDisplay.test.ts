import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  normalizeProviderAccentColor,
  providerInstanceInitials,
  providerInstanceInitialsGlyphScale,
  resolveProviderInstanceBadgeLabel,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "./providerInstanceDisplay.ts";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const acpRegistry = ProviderDriverKind.make("acpRegistry");

describe("resolveProviderInstanceDisplayName", () => {
  it("keeps a snapshot name that differs from the brand label", () => {
    expect(
      resolveProviderInstanceDisplayName({
        instanceId: ProviderInstanceId.make("codex"),
        driver: codex,
        displayName: "Work",
      }),
    ).toBe("Work");
  });

  it("humanizes a custom instance id when the snapshot only carries the brand label", () => {
    expect(
      resolveProviderInstanceDisplayName({
        instanceId: ProviderInstanceId.make("codex_personal"),
        driver: codex,
        displayName: "Codex",
      }),
    ).toBe("Codex Personal");
  });

  it("uses the brand label for the default instance", () => {
    expect(
      resolveProviderInstanceDisplayName({
        instanceId: ProviderInstanceId.make("codex"),
        driver: codex,
      }),
    ).toBe("Codex");
  });
});

describe("providerInstanceInitials", () => {
  it("takes the first two characters of a single word", () => {
    expect(providerInstanceInitials("Codex")).toBe("CO");
  });

  it("takes the first character of each of the first two words", () => {
    expect(providerInstanceInitials("Codex Personal")).toBe("CP");
  });

  it("ignores words past the first two", () => {
    expect(providerInstanceInitials("Codex Personal Backup Account")).toBe("CP");
  });

  it("returns an empty string for an empty label", () => {
    expect(providerInstanceInitials("")).toBe("");
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
  it("accepts a lowercase hex color", () => {
    expect(normalizeProviderAccentColor("#ff8800")).toBe("#ff8800");
  });

  it("accepts an uppercase hex color", () => {
    expect(normalizeProviderAccentColor("#FF8800")).toBe("#FF8800");
  });

  it("rejects a non-hex value", () => {
    expect(normalizeProviderAccentColor("blue")).toBeUndefined();
  });

  it("rejects a short hex value", () => {
    expect(normalizeProviderAccentColor("#fff")).toBeUndefined();
  });

  it("treats undefined and blank as unset", () => {
    expect(normalizeProviderAccentColor(undefined)).toBeUndefined();
    expect(normalizeProviderAccentColor("   ")).toBeUndefined();
  });
});

describe("shouldShowInstanceBadge", () => {
  it("hides badges for distinct ACP agents sharing the registry driver", () => {
    const mistral = { driverKind: acpRegistry, acpRegistryAgentId: "mistral-vibe" };
    const devin = { driverKind: acpRegistry, acpRegistryAgentId: "devin" };
    expect(shouldShowInstanceBadge(mistral, [mistral, devin])).toBe(false);
    expect(shouldShowInstanceBadge(devin, [mistral, devin])).toBe(false);
  });

  it("shows badges for multiple instances of the same ACP agent", () => {
    const first = { driverKind: acpRegistry, acpRegistryAgentId: "mistral-vibe" };
    const second = { ...first };
    expect(shouldShowInstanceBadge(first, [first, second])).toBe(true);
  });

  it("keeps an explicit accent on a single ACP agent", () => {
    const entry = {
      driverKind: acpRegistry,
      acpRegistryAgentId: "mistral-vibe",
      accentColor: "#ff8800",
    };
    expect(shouldShowInstanceBadge(entry, [entry])).toBe(true);
  });

  it("distinguishes registry instances whose agent identity is unavailable", () => {
    const entry = { driverKind: acpRegistry };
    expect(shouldShowInstanceBadge(entry, [entry, { ...entry }])).toBe(true);
  });

  it("shows the badge when the entry has an accent color", () => {
    const entry = { driverKind: codex, accentColor: "#ff8800" };
    expect(shouldShowInstanceBadge(entry, [entry])).toBe(true);
  });

  it("shows the badge when two entries share a driver, even without an accent", () => {
    const first = { driverKind: codex, accentColor: undefined };
    const second = { driverKind: codex, accentColor: undefined };
    expect(shouldShowInstanceBadge(first, [first, second])).toBe(true);
  });

  it("hides the badge for a single instance of a driver with no accent", () => {
    const entry = { driverKind: codex, accentColor: undefined };
    const other = { driverKind: claude, accentColor: undefined };
    expect(shouldShowInstanceBadge(entry, [entry, other])).toBe(false);
  });

  it("shows the badge when the entry has a badge label", () => {
    const entry = { driverKind: claude, badgeLabel: "KI" };
    expect(shouldShowInstanceBadge(entry, [entry])).toBe(true);
  });

  it("compares chosen glyphs rather than drivers", () => {
    const claudeLogo = { driverKind: claude };
    const openAiLogo = { driverKind: claude, icon: "codex" };
    const codexDefault = { driverKind: codex };
    expect(shouldShowInstanceBadge(claudeLogo, [claudeLogo, openAiLogo])).toBe(false);
    expect(shouldShowInstanceBadge(openAiLogo, [claudeLogo, openAiLogo, codexDefault])).toBe(true);
  });

  it("treats an unknown chosen icon as the driver glyph it falls back to", () => {
    const claudeDefault = { driverKind: claude };
    const futureLogo = { driverKind: claude, icon: "future-logo" };
    expect(shouldShowInstanceBadge(futureLogo, [claudeDefault, futureLogo])).toBe(true);
  });

  it("never badges an initials glyph, which already shows the label", () => {
    const entry = { driverKind: claude, icon: "initials", accentColor: "#ff8800" };
    expect(shouldShowInstanceBadge(entry, [entry, { ...entry }])).toBe(false);
  });

  it("does not count an initials glyph as sharing its driver's logo", () => {
    const claudeLogo = { driverKind: claude };
    const initials = { driverKind: claude, icon: "initials" };
    expect(shouldShowInstanceBadge(claudeLogo, [claudeLogo, initials])).toBe(false);
  });
});
