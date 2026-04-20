import { DEFAULT_UNIFIED_SETTINGS } from "@workbench/contracts/settings";
import type { ModelSelection, ServerProvider } from "@workbench/contracts";
import { describe, expect, it } from "vitest";

import { deriveEffectiveComposerModelState } from "./composerDraftStore";

function makeProvider(input: {
  provider: ServerProvider["provider"];
  models: ServerProvider["models"];
}): ServerProvider {
  return {
    provider: input.provider,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-04-19T00:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: input.models,
  };
}

const EMPTY_CAPABILITIES = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const TEST_PROVIDERS: ReadonlyArray<ServerProvider> = [
  makeProvider({
    provider: "codex",
    models: [
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      },
    ],
  }),
  makeProvider({
    provider: "pi",
    models: [
      {
        slug: "openai-codex/gpt-5.4",
        name: "openai-codex/gpt-5.4",
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      },
      {
        slug: "anthropic/claude-sonnet-4-6",
        name: "anthropic/claude-sonnet-4-6",
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      },
    ],
  }),
];

describe("deriveEffectiveComposerModelState", () => {
  it("uses the selected provider's default model instead of carrying over another provider's model", () => {
    const threadModelSelection: ModelSelection = {
      provider: "codex",
      model: "gpt-5.4",
    };
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providers: {
        ...DEFAULT_UNIFIED_SETTINGS.providers,
        pi: {
          ...DEFAULT_UNIFIED_SETTINGS.providers.pi,
          defaultModel: "openai-codex/gpt-5.4",
        },
      },
    };

    expect(
      deriveEffectiveComposerModelState({
        draft: null,
        providers: TEST_PROVIDERS,
        selectedProvider: "pi",
        threadModelSelection,
        projectModelSelection: null,
        settings,
      }).selectedModel,
    ).toBe("openai-codex/gpt-5.4");
  });
});
