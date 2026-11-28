import {
  EnvironmentId,
  type InferenceProviderConfig,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  nativeAccountProviders,
  normalizeProviderAccentColor,
  providerAccentForegroundColor,
  providerInstanceInitials,
  shouldShowInstanceBadge,
} from "./providerInstanceDisplay.ts";

const codex = ProviderDriverKind.make("codex");
const acpRegistry = ProviderDriverKind.make("acpRegistry");

describe("nativeAccountProviders", () => {
  it("keeps native accounts for additive routes and hides accounts replaced by an active route", () => {
    const route = {
      inferenceEnabled: true,
      inferenceHostId: EnvironmentId.make("inference-host"),
      inferenceHostLabel: "Inference host",
      inferenceBaseUrl: "https://host.example/v1",
      inferenceKey: "route-key",
      inferenceModels: ["host-model"],
      inferenceHomePath: "/state/inference",
    } satisfies InferenceProviderConfig;
    const instances = {
      [ProviderInstanceId.make("codex")]: { driver: codex, config: route },
      [ProviderInstanceId.make("claudeAgent")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: route,
      },
      [ProviderInstanceId.make("pi")]: { driver: ProviderDriverKind.make("pi"), config: route },
      [ProviderInstanceId.make("opencode")]: {
        driver: ProviderDriverKind.make("opencode"),
        config: route,
      },
      [ProviderInstanceId.make("codex_native")]: { driver: codex, config: {} },
      [ProviderInstanceId.make("codex_disabled")]: {
        driver: codex,
        config: { ...route, inferenceEnabled: false },
      },
      [ProviderInstanceId.make("codex_incomplete")]: {
        driver: codex,
        config: { inferenceEnabled: true },
      },
    } satisfies ServerSettings["providerInstances"];
    const providers = [
      ...Object.entries(instances).map(([id, instance]) => ({
        instanceId: ProviderInstanceId.make(id),
        driver: instance.driver,
      })),
      { instanceId: ProviderInstanceId.make("cursor"), driver: ProviderDriverKind.make("cursor") },
    ];

    expect(
      nativeAccountProviders(providers, instances).map((provider) => provider.instanceId),
    ).toEqual(["pi", "opencode", "cursor"]);
  });
});

describe("providerInstanceInitials", () => {
  it("treats punctuation and camel-case humps as word breaks but keeps apostrophes between letters", () => {
    expect(providerInstanceInitials("Codex (hub)")).toBe("CH");
    expect(providerInstanceInitials("work_codex")).toBe("WC");
    expect(providerInstanceInitials("Theo's Codex")).toBe("TC");
    expect(providerInstanceInitials("Codex 'hub'")).toBe("CH");
    expect(providerInstanceInitials("‘hub’")).toBe("HU");
    expect(providerInstanceInitials("(hub)")).toBe("HU");
    expect(providerInstanceInitials("ClaudeProx")).toBe("CP");
    expect(providerInstanceInitials("ClaudeAPI")).toBe("CA");
    expect(providerInstanceInitials("API")).toBe("AP");
    expect(providerInstanceInitials("ClaudeProx Work")).toBe("CW");
    expect(providerInstanceInitials("(ClaudeProx)")).toBe("CP");
  });

  it("keeps an emoji whole instead of splitting its surrogate pair", () => {
    expect(providerInstanceInitials("😀 Work")).toBe("😀W");
    expect(providerInstanceInitials("😀")).toBe("😀");
  });

  it("normalizes decomposed accents before extracting initials", () => {
    expect(providerInstanceInitials("E\u0301clair")).toBe("ÉC");
    expect(providerInstanceInitials("E\u0301clair Pro")).toBe("ÉP");
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

  it("ignores a non-hex accent color", () => {
    const entry = { driverKind: codex, accentColor: "blue", enabled: true };
    expect(shouldShowInstanceBadge(entry, [entry])).toBe(false);
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
});
