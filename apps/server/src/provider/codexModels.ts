import type { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";

const DEFAULT_CODEX_REASONING_LABELS: Record<string, string> = {
  xhigh: "Extra High",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const DEFAULT_CODEX_MODEL_CAPABILITIES: ModelCapabilities = {
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
};

export const BUILT_IN_CODEX_MODELS: ReadonlyArray<ServerProviderModel> = [
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
  {
    slug: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
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
  {
    slug: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
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
  {
    slug: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
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
  {
    slug: "gpt-5.2-codex",
    name: "GPT-5.2 Codex",
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
  {
    slug: "gpt-5.2",
    name: "GPT-5.2",
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

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readArray(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmptyTrimmed(value: unknown): string | undefined {
  const candidate = readString(value)?.trim();
  return candidate ? candidate : undefined;
}

function codexReasoningLabel(value: string): string {
  return DEFAULT_CODEX_REASONING_LABELS[value] ?? value;
}

function parseCodexModelCapabilities(
  record: Record<string, unknown>,
  fallbackSlug: string,
): ModelCapabilities {
  const fallbackCapabilities =
    BUILT_IN_CODEX_MODELS.find((candidate) => candidate.slug === fallbackSlug)?.capabilities ??
    DEFAULT_CODEX_MODEL_CAPABILITIES;
  const defaultReasoningEffort = nonEmptyTrimmed(record.defaultReasoningEffort);
  const reasoningEffortLevels = (readArray(record.supportedReasoningEfforts) ?? [])
    .flatMap((value) => {
      const effortRecord = readObject(value);
      const effort = nonEmptyTrimmed(
        effortRecord?.reasoningEffort ?? effortRecord?.value ?? effortRecord?.id,
      );
      if (!effort) {
        return [];
      }

      return [
        {
          value: effort,
          label: codexReasoningLabel(effort),
          ...(effort === defaultReasoningEffort ? { isDefault: true } : {}),
        },
      ];
    })
    .filter(
      (candidate, index, values) =>
        values.findIndex((entry) => entry.value === candidate.value) === index,
    );

  if (reasoningEffortLevels.length === 0) {
    return fallbackCapabilities;
  }

  return {
    reasoningEffortLevels,
    supportsFastMode: fallbackCapabilities.supportsFastMode,
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  };
}

export function getCodexModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  return (
    BUILT_IN_CODEX_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ??
    DEFAULT_CODEX_MODEL_CAPABILITIES
  );
}

export function parseCodexModelListResult(result: unknown): ReadonlyArray<ServerProviderModel> {
  const resultRecord = readObject(result);
  const rawModels = readArray(resultRecord?.data) ?? readArray(result) ?? [];
  const seen = new Set<string>();

  return rawModels.flatMap((value) => {
    const modelRecord = readObject(value);
    if (!modelRecord || modelRecord.hidden === true) {
      return [];
    }

    const slug = nonEmptyTrimmed(modelRecord.id) ?? nonEmptyTrimmed(modelRecord.model);
    if (!slug || seen.has(slug)) {
      return [];
    }
    seen.add(slug);

    return [
      {
        slug,
        name:
          BUILT_IN_CODEX_MODELS.find((candidate) => candidate.slug === slug)?.name ??
          nonEmptyTrimmed(modelRecord.displayName) ??
          slug,
        isCustom: false,
        capabilities: parseCodexModelCapabilities(modelRecord, slug),
      } satisfies ServerProviderModel,
    ];
  });
}
