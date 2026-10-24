import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { resolveDefaultModelSettingsPresentation } from "./ProjectDefaultsSettings.logic";

const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
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

function present(input: {
  providers: ReadonlyArray<ServerProvider>;
  saved: ReturnType<typeof createModelSelection> | null;
  settings?: UnifiedSettings;
}) {
  const settings = input.settings ?? DEFAULT_UNIFIED_SETTINGS;
  return resolveDefaultModelSettingsPresentation({
    entries: sortProviderInstanceEntries(
      applyProviderInstanceSettings(deriveProviderInstanceEntries(input.providers), settings, null),
    ),
    providers: input.providers,
    settings,
    saved: input.saved,
  });
}

function claudeOff(): UnifiedSettings {
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [claudeId]: { driver: ProviderDriverKind.make("claudeAgent"), enabled: false },
    },
  };
}

describe("resolveDefaultModelSettingsPresentation", () => {
  it("keeps a saved model when its provider is turned off and locks effort", () => {
    const row = present({
      providers: claudeAndCodex.map((entry) =>
        entry.instanceId === claudeId ? { ...entry, enabled: false } : entry,
      ),
      saved: savedClaude,
      settings: claudeOff(),
    });
    expect(row).toMatchObject({
      selection: savedClaude,
      effortLocked: true,
      note: "Claude is turned off.",
    });
  });

  it("keeps the saved model when settings turn the provider off before the snapshot updates", () => {
    const row = present({ providers: claudeAndCodex, saved: savedClaude, settings: claudeOff() });
    expect(row.selection).toBe(savedClaude);
    expect(row.effortLocked).toBe(true);
    expect(row.note).toBe("Claude is turned off.");
  });

  it("keeps the saved model when its provider is unavailable", () => {
    const row = present({
      providers: claudeAndCodex.map((entry) =>
        entry.instanceId === claudeId ? { ...entry, availability: "unavailable" as const } : entry,
      ),
      saved: savedClaude,
    });
    expect(row).toMatchObject({
      selection: savedClaude,
      effortLocked: true,
      note: "Claude is unavailable.",
    });
  });

  it("keeps the saved model when its provider is absent from this environment", () => {
    const row = present({
      providers: claudeAndCodex.filter((entry) => entry.instanceId !== claudeId),
      saved: savedClaude,
    });
    expect(row).toMatchObject({
      selection: savedClaude,
      effortLocked: true,
      note: "This provider is not available on this environment.",
    });
  });

  it("leaves effort editable when the saved provider can run", () => {
    const row = present({ providers: claudeAndCodex, saved: savedClaude });
    expect(row.selection).toBe(savedClaude);
    expect(row.effortLocked).toBe(false);
    expect(row.note).toBeNull();
  });

  it("shows the automatic fallback when nothing is saved", () => {
    const row = present({ providers: claudeAndCodex, saved: null });
    expect(row).toMatchObject({
      effortLocked: false,
      note: null,
      selection: { instanceId: codexId, model: "gpt-5.6" },
    });
  });

  it("still follows a hidden model on the same provider", () => {
    const settings: UnifiedSettings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerModelPreferences: {
        [claudeId]: { hiddenModels: ["claude-opus-4-8"], modelOrder: [] },
      },
    };
    const row = present({
      providers: [
        provider({
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          models: ["claude-sonnet-5", "claude-opus-4-8"],
        }),
      ],
      saved: savedClaude,
      settings,
    });
    expect(row.effortLocked).toBe(false);
    expect(row.selection).toMatchObject({ instanceId: claudeId, model: "claude-sonnet-5" });
  });
});
