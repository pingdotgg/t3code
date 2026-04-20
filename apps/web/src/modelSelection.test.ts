import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@workbench/contracts/settings";
import type { ServerProvider } from "@workbench/contracts";
import { describe, expect, it } from "vitest";

import {
  getConfiguredFavoriteModelOptions,
  getCustomModelOptionsByProvider,
  resolveProviderDefaultModel,
} from "./modelSelection";

const TEST_PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    provider: "pi",
    enabled: true,
    installed: true,
    version: "0.60.0",
    status: "ready",
    auth: { status: "authenticated", type: "pi", label: "pi login" },
    checkedAt: "2026-04-19T00:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: [
      {
        slug: "openai-codex/gpt-5.4",
        name: "openai-codex/gpt-5.4",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
      {
        slug: "anthropic/claude-sonnet-4-6",
        name: "anthropic/claude-sonnet-4-6",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: true,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
      {
        slug: "anthropic/claude-haiku-4-5",
        name: "anthropic/claude-haiku-4-5",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
  },
];

function withPiSettings(overrides: Partial<UnifiedSettings["providers"]["pi"]>): UnifiedSettings {
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    providers: {
      ...DEFAULT_UNIFIED_SETTINGS.providers,
      pi: {
        ...DEFAULT_UNIFIED_SETTINGS.providers.pi,
        ...overrides,
      },
    },
  };
}

describe("modelSelection Pi preferences", () => {
  it("returns only configured available favorites in configured order", () => {
    const settings = withPiSettings({
      favoriteModels: ["anthropic/claude-haiku-4-5", "missing/model", "openai-codex/gpt-5.4"],
    });

    expect(getConfiguredFavoriteModelOptions(settings, TEST_PROVIDERS, "pi")).toEqual([
      {
        slug: "anthropic/claude-haiku-4-5",
        name: "anthropic/claude-haiku-4-5",
      },
      {
        slug: "openai-codex/gpt-5.4",
        name: "openai-codex/gpt-5.4",
      },
    ]);
  });

  it("uses the explicit Pi default when it is part of the preferred set", () => {
    const settings = withPiSettings({
      favoriteModels: ["anthropic/claude-sonnet-4-6", "openai-codex/gpt-5.4"],
      defaultModel: "openai-codex/gpt-5.4",
    });

    expect(resolveProviderDefaultModel("pi", settings, TEST_PROVIDERS)).toBe(
      "openai-codex/gpt-5.4",
    );
  });

  it("falls back to the first preferred Pi model when the explicit default is unavailable", () => {
    const settings = withPiSettings({
      favoriteModels: ["anthropic/claude-haiku-4-5", "openai-codex/gpt-5.4"],
      defaultModel: "anthropic/claude-sonnet-4-6",
    });

    expect(resolveProviderDefaultModel("pi", settings, TEST_PROVIDERS)).toBe(
      "anthropic/claude-haiku-4-5",
    );
  });

  it("limits the Pi picker options to preferred models", () => {
    const settings = withPiSettings({
      favoriteModels: ["openai-codex/gpt-5.4", "anthropic/claude-haiku-4-5"],
    });

    expect(getCustomModelOptionsByProvider(settings, TEST_PROVIDERS).pi).toEqual([
      {
        slug: "openai-codex/gpt-5.4",
        name: "openai-codex/gpt-5.4",
      },
      {
        slug: "anthropic/claude-haiku-4-5",
        name: "anthropic/claude-haiku-4-5",
      },
    ]);
  });
});
