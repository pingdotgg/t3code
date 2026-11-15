import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { providerInstanceEntriesFor } from "../../providerInstances";
import { resolveDefaultModelSettingsPresentation } from "./ProjectDefaultsSettings.logic";

const claudeId = ProviderInstanceId.make("claudeAgent");
const high = [{ id: "effort", value: "high" }];
const savedClaude = createModelSelection(claudeId, "claude-opus-4-8", high);
function provider(input: {
  instanceId: string;
  driver: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  models: ReadonlyArray<string>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      ...(index === 0 ? { isDefault: true } : {}),
      capabilities: {},
    })),
    slashCommands: [],
    skills: [],
  };
}

const claudeAndCodex = [
  provider({ instanceId: "codex", driver: "codex", models: ["gpt-5.6"] }),
  provider({ instanceId: "claudeAgent", driver: "claudeAgent", models: ["claude-opus-4-8"] }),
];

function present(
  providers: ReadonlyArray<ServerProvider>,
  overrides: Partial<UnifiedSettings> = {},
) {
  const settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    defaultModelSelection: savedClaude,
    ...overrides,
  };
  return resolveDefaultModelSettingsPresentation({
    entries: providerInstanceEntriesFor(providers, settings, null),
    providers,
    settings,
    projectId: null,
  });
}

const claudeOff: Partial<UnifiedSettings> = {
  providerInstances: {
    [claudeId]: { driver: ProviderDriverKind.make("claudeAgent"), enabled: false },
  },
};

describe("resolveDefaultModelSettingsPresentation", () => {
  it("keeps the saved model and explains why when its provider cannot run", () => {
    const withoutClaude = claudeAndCodex.filter((entry) => entry.instanceId !== claudeId);
    const claudeUnavailable = claudeAndCodex.map((entry) =>
      entry.instanceId === claudeId ? { ...entry, availability: "unavailable" as const } : entry,
    );
    // Settings turn Claude off before the server snapshot reflects it.
    expect(present(claudeAndCodex, claudeOff)).toEqual({
      selection: savedClaude,
      providerNote: "Claude is turned off.",
    });
    expect(present(claudeUnavailable)).toEqual({
      selection: savedClaude,
      providerNote: "Claude is unavailable.",
    });
    expect(present(withoutClaude)).toEqual({
      selection: savedClaude,
      providerNote: "This provider is not available on this environment.",
    });
  });

  it("leaves effort editable when the saved provider can run", () => {
    expect(present(claudeAndCodex)).toEqual({ selection: savedClaude, providerNote: null });
  });

  it("still follows a hidden model on the same provider", () => {
    const row = present(
      [
        provider({
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          models: ["claude-sonnet-5", "claude-opus-4-8"],
        }),
      ],
      {
        providerModelPreferences: {
          [claudeId]: { hiddenModels: ["claude-opus-4-8"], modelOrder: [] },
        },
      },
    );
    expect(row.providerNote).toBeNull();
    expect(row.selection).toMatchObject({ instanceId: claudeId, model: "claude-sonnet-5" });
  });
});
