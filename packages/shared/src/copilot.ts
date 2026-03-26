import type { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";

const COPILOT_REASONING_CAPABILITIES = {
  reasoningEffortLevels: [
    { value: "xhigh", label: "Extra High" },
    { value: "high", label: "High", isDefault: true },
    { value: "medium", label: "Medium" },
    { value: "low", label: "Low" },
  ],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  promptInjectedEffortLevels: [],
} satisfies ModelCapabilities;

const COPILOT_BASIC_CAPABILITIES = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  promptInjectedEffortLevels: [],
} satisfies ModelCapabilities;

export const COPILOT_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5.4",
    name: "GPT-5.4",
    isCustom: false,
    capabilities: COPILOT_REASONING_CAPABILITIES,
  },
  {
    slug: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    isCustom: false,
    capabilities: COPILOT_REASONING_CAPABILITIES,
  },
  {
    slug: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    isCustom: false,
    capabilities: COPILOT_REASONING_CAPABILITIES,
  },
  {
    slug: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: COPILOT_BASIC_CAPABILITIES,
  },
  {
    slug: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: COPILOT_BASIC_CAPABILITIES,
  },
  {
    slug: "claude-opus-4.6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: COPILOT_BASIC_CAPABILITIES,
  },
  {
    slug: "claude-opus-4.6-fast",
    name: "Claude Opus 4.6 (Fast Mode)",
    isCustom: false,
    capabilities: COPILOT_BASIC_CAPABILITIES,
  },
  {
    slug: "gemini-3.0",
    name: "Gemini 3.0 Pro",
    isCustom: false,
    capabilities: COPILOT_BASIC_CAPABILITIES,
  },
];

export function getCopilotBuiltInModelCapabilities(
  model: string | null | undefined,
): ModelCapabilities | null {
  const slug = model?.trim();
  return COPILOT_BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ?? null;
}
