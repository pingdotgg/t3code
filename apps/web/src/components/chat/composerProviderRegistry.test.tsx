import { describe, expect, it } from "vitest";
import type { ServerProviderModel } from "@t3tools/contracts";
import {
  getComposerProviderState,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderRegistry";

const CODEX_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5.4",
    name: "GPT-5.4",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
];

const CLAUDE_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
        { value: "max", label: "Max" },
        { value: "ultrathink", label: "Ultrathink" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: ["ultrathink"],
    },
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
        { value: "ultrathink", label: "Ultrathink" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: ["ultrathink"],
    },
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: true,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
];

const CLAUDE_MODELS_WITH_CONTEXT_WINDOW: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
        { value: "max", label: "Max" },
        { value: "ultrathink", label: "Ultrathink" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [
        { value: "200k", label: "200k", isDefault: true },
        { value: "1m", label: "1M" },
      ],
      promptInjectedEffortLevels: ["ultrathink"],
    },
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: true,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
];

describe("getComposerProviderState", () => {
  it("returns codex defaults when no codex draft options exist", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      models: CODEX_MODELS,
      prompt: "",
      modelOptions: undefined,
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "high",
      modelOptionsForDispatch: {
        reasoningEffort: "high",
      },
    });
  });

  it("normalizes codex dispatch options while preserving the selected effort", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      models: CODEX_MODELS,
      prompt: "",
      modelOptions: {
        codex: {
          reasoningEffort: "low",
          fastMode: true,
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "low",
      modelOptionsForDispatch: {
        reasoningEffort: "low",
        fastMode: true,
      },
    });
  });

  it("preserves codex fast mode when it is the only active option", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      models: CODEX_MODELS,
      prompt: "",
      modelOptions: {
        codex: {
          fastMode: true,
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "high",
      modelOptionsForDispatch: {
        reasoningEffort: "high",
        fastMode: true,
      },
    });
  });

  it("preserves codex default effort explicitly in dispatch options", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      models: CODEX_MODELS,
      prompt: "",
      modelOptions: {
        codex: {
          reasoningEffort: "high",
          fastMode: false,
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "high",
      modelOptionsForDispatch: {
        reasoningEffort: "high",
        fastMode: false,
      },
    });
  });

  it("returns Claude defaults for effort-capable models", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      models: CLAUDE_MODELS,
      prompt: "",
      modelOptions: undefined,
    });

    expect(state).toEqual({
      provider: "claudeAgent",
      promptEffort: "high",
      modelOptionsForDispatch: {
        effort: "high",
      },
    });
  });

  it("tracks Claude ultrathink from the prompt without changing dispatch effort", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      models: CLAUDE_MODELS,
      prompt: "Ultrathink:\nInvestigate this failure",
      modelOptions: {
        claudeAgent: {
          effort: "medium",
        },
      },
    });

    expect(state).toEqual({
      provider: "claudeAgent",
      promptEffort: "medium",
      modelOptionsForDispatch: {
        effort: "medium",
      },
      composerFrameClassName: "ultrathink-frame",
      composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.04)_inset]",
      modelPickerIconClassName: "ultrathink-chroma",
    });
  });

  it("drops unsupported Claude effort options for models without effort controls", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-haiku-4-5",
      models: CLAUDE_MODELS,
      prompt: "",
      modelOptions: {
        claudeAgent: {
          effort: "max",
          thinking: false,
        },
      },
    });

    expect(state).toEqual({
      provider: "claudeAgent",
      promptEffort: null,
      modelOptionsForDispatch: {
        thinking: false,
      },
    });
  });

  it("preserves Claude fast mode when it is the only active option", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      models: CLAUDE_MODELS,
      prompt: "",
      modelOptions: {
        claudeAgent: {
          fastMode: true,
        },
      },
    });

    expect(state).toEqual({
      provider: "claudeAgent",
      promptEffort: "high",
      modelOptionsForDispatch: {
        effort: "high",
        fastMode: true,
      },
    });
  });

  it("preserves Claude default effort explicitly in dispatch options", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      models: CLAUDE_MODELS,
      prompt: "",
      modelOptions: {
        claudeAgent: {
          effort: "high",
          fastMode: false,
        },
      },
    });

    expect(state).toEqual({
      provider: "claudeAgent",
      promptEffort: "high",
      modelOptionsForDispatch: {
        effort: "high",
        fastMode: false,
      },
    });
  });

  it("preserves explicit fastMode: false so deepMerge can overwrite a prior true", () => {
    // Regression: normalizeClaudeModelOptionsWithCapabilities used to strip
    // fastMode: false, which meant deepMerge could never clear a previous true.
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      models: CLAUDE_MODELS,
      prompt: "",
      modelOptions: {
        claudeAgent: {
          effort: "high",
          fastMode: false,
        },
      },
    });

    expect(state.modelOptionsForDispatch).toHaveProperty("fastMode", false);
  });

  it("preserves explicit thinking: true so deepMerge can overwrite a prior false", () => {
    // Regression: thinking: true (the default) used to be stripped, which
    // meant deepMerge could never clear a previous thinking: false.
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-haiku-4-5",
      models: CLAUDE_MODELS,
      prompt: "",
      modelOptions: {
        claudeAgent: {
          thinking: true,
        },
      },
    });

    expect(state.modelOptionsForDispatch).toHaveProperty("thinking", true);
  });

  it("preserves Claude default context window explicitly in dispatch options", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      models: CLAUDE_MODELS_WITH_CONTEXT_WINDOW,
      prompt: "",
      modelOptions: {
        claudeAgent: {
          effort: "high",
          contextWindow: "200k",
        },
      },
    });

    expect(state.modelOptionsForDispatch).toMatchObject({
      effort: "high",
      contextWindow: "200k",
    });
  });

  it("preserves explicit contextWindow default so deepMerge can overwrite a prior 1m", () => {
    // Regression: the default contextWindow must survive normalization so
    // deepMerge can clear an older non-default 1m selection.
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      models: CLAUDE_MODELS_WITH_CONTEXT_WINDOW,
      prompt: "",
      modelOptions: {
        claudeAgent: {
          contextWindow: "200k",
        },
      },
    });

    expect(state.modelOptionsForDispatch).toHaveProperty("contextWindow", "200k");
  });

  it("omits contextWindow when the model does not support it", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-haiku-4-5",
      models: CLAUDE_MODELS_WITH_CONTEXT_WINDOW,
      prompt: "",
      modelOptions: {
        claudeAgent: {
          contextWindow: "1m",
        },
      },
    });

    expect(state.modelOptionsForDispatch).toBeUndefined();
  });

  it("omits fastMode when the model does not support it", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      models: CLAUDE_MODELS,
      prompt: "",
      modelOptions: {
        claudeAgent: {
          effort: "high",
          fastMode: true,
        },
      },
    });

    expect(state.modelOptionsForDispatch).not.toHaveProperty("fastMode");
  });
});

describe("provider traits render guards", () => {
  it("returns null for codex traits picker when no thread target is provided", () => {
    const content = renderProviderTraitsPicker({
      provider: "codex",
      model: "gpt-5.4",
      models: CODEX_MODELS,
      modelOptions: undefined,
      prompt: "",
      onPromptChange: () => {},
    });

    expect(content).toBeNull();
  });

  it("returns null for claude traits menu content when no thread target is provided", () => {
    const content = renderProviderTraitsMenuContent({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      models: CLAUDE_MODELS,
      modelOptions: undefined,
      prompt: "",
      onPromptChange: () => {},
    });

    expect(content).toBeNull();
  });
});
