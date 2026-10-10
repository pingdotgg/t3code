import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  normalizeProviderAccentColor,
  providerInstanceInitials,
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
    const mistral = { driverKind: acpRegistry, acpRegistryAgentId: "mistral-vibe", enabled: true };
    const devin = { driverKind: acpRegistry, acpRegistryAgentId: "devin", enabled: true };
    expect(shouldShowInstanceBadge(mistral, [mistral, devin])).toBe(false);
    expect(shouldShowInstanceBadge(devin, [mistral, devin])).toBe(false);
  });

  it("shows badges for multiple instances of the same ACP agent", () => {
    const first = { driverKind: acpRegistry, acpRegistryAgentId: "mistral-vibe", enabled: true };
    const second = { ...first };
    expect(shouldShowInstanceBadge(first, [first, second])).toBe(true);
  });

  it("keeps an explicit accent on a single ACP agent", () => {
    const entry = {
      driverKind: acpRegistry,
      acpRegistryAgentId: "mistral-vibe",
      accentColor: "#ff8800",
      enabled: true,
    };
    expect(shouldShowInstanceBadge(entry, [entry])).toBe(true);
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

  it("hides the badge when the other instance sharing the driver is disabled", () => {
    const entry = { driverKind: codex, accentColor: undefined, enabled: true };
    const disabled = { driverKind: codex, accentColor: undefined, enabled: false };
    expect(shouldShowInstanceBadge(entry, [entry, disabled])).toBe(false);
  });

  it("keeps the badge on a disabled instance that shares a driver with an enabled one", () => {
    const enabled = { driverKind: codex, accentColor: undefined, enabled: true };
    const disabled = { driverKind: codex, accentColor: undefined, enabled: false };
    expect(shouldShowInstanceBadge(disabled, [enabled, disabled])).toBe(true);
  });

  it("hides the badge for a single instance of a driver with no accent", () => {
    const entry = { driverKind: codex, accentColor: undefined, enabled: true };
    const other = { driverKind: claude, accentColor: undefined, enabled: true };
    expect(shouldShowInstanceBadge(entry, [entry, other])).toBe(false);
  });
});
