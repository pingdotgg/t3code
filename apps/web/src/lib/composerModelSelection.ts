import {
  type ClaudeCodeEffort,
  type CodexReasoningEffort,
  type ModelSelection,
  type ProviderKind,
  type ProviderModelOptions,
} from "@t3tools/contracts";
import { getDefaultModel, normalizeModelSlug } from "@t3tools/shared/model";

export type LegacyCodexFields = {
  effort?: CodexReasoningEffort;
  codexFastMode?: boolean;
  serviceTier?: string;
};

export function makeModelSelection(
  provider: ProviderKind,
  model: string,
  options?: ProviderModelOptions[ProviderKind],
): ModelSelection {
  switch (provider) {
    case "codex":
      return {
        provider: "codex",
        model,
        ...(options ? { options: options as ProviderModelOptions["codex"] } : {}),
      };
    case "claudeAgent":
      return {
        provider: "claudeAgent",
        model,
        ...(options ? { options: options as ProviderModelOptions["claudeAgent"] } : {}),
      };
    case "factoryDroid":
      return {
        provider: "factoryDroid",
        model,
        ...(options ? { options: options as ProviderModelOptions["factoryDroid"] } : {}),
      };
  }
}

export function normalizeProviderKind(value: unknown): ProviderKind | null {
  return value === "codex" || value === "claudeAgent" || value === "factoryDroid" ? value : null;
}

export function providerModelOptionsFromSelection(
  modelSelection: ModelSelection | null | undefined,
): ProviderModelOptions | null {
  if (!modelSelection?.options) {
    return null;
  }
  return {
    [modelSelection.provider]: modelSelection.options,
  };
}

export function modelSelectionByProviderToOptions(
  map: Partial<Record<ProviderKind, ModelSelection>> | null | undefined,
): ProviderModelOptions | null {
  if (!map) return null;
  const result: Record<string, unknown> = {};
  for (const [provider, selection] of Object.entries(map)) {
    if (selection?.options) {
      result[provider] = selection.options;
    }
  }
  return Object.keys(result).length > 0 ? (result as ProviderModelOptions) : null;
}

export function normalizeProviderModelOptions(
  value: unknown,
  provider?: ProviderKind | null,
  legacy?: LegacyCodexFields,
): ProviderModelOptions | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const codexCandidate =
    candidate?.codex && typeof candidate.codex === "object"
      ? (candidate.codex as Record<string, unknown>)
      : null;
  const claudeCandidate =
    candidate?.claudeAgent && typeof candidate.claudeAgent === "object"
      ? (candidate.claudeAgent as Record<string, unknown>)
      : null;
  const factoryDroidCandidate =
    candidate?.factoryDroid && typeof candidate.factoryDroid === "object"
      ? (candidate.factoryDroid as Record<string, unknown>)
      : null;

  const codexReasoningEffort: CodexReasoningEffort | undefined =
    codexCandidate?.reasoningEffort === "low" ||
    codexCandidate?.reasoningEffort === "medium" ||
    codexCandidate?.reasoningEffort === "high" ||
    codexCandidate?.reasoningEffort === "xhigh"
      ? codexCandidate.reasoningEffort
      : provider === "codex" &&
          (legacy?.effort === "low" ||
            legacy?.effort === "medium" ||
            legacy?.effort === "high" ||
            legacy?.effort === "xhigh")
        ? legacy.effort
        : undefined;
  const codexFastMode =
    codexCandidate?.fastMode === true
      ? true
      : codexCandidate?.fastMode === false
        ? false
        : (provider === "codex" && legacy?.codexFastMode === true) ||
            (typeof legacy?.serviceTier === "string" && legacy.serviceTier === "fast")
          ? true
          : undefined;
  const codex =
    codexReasoningEffort !== undefined || codexFastMode !== undefined
      ? {
          ...(codexReasoningEffort !== undefined ? { reasoningEffort: codexReasoningEffort } : {}),
          ...(codexFastMode !== undefined ? { fastMode: codexFastMode } : {}),
        }
      : undefined;

  const claudeThinking =
    claudeCandidate?.thinking === true
      ? true
      : claudeCandidate?.thinking === false
        ? false
        : undefined;
  const claudeEffort: ClaudeCodeEffort | undefined =
    claudeCandidate?.effort === "low" ||
    claudeCandidate?.effort === "medium" ||
    claudeCandidate?.effort === "high" ||
    claudeCandidate?.effort === "max" ||
    claudeCandidate?.effort === "ultrathink"
      ? claudeCandidate.effort
      : undefined;
  const claudeFastMode =
    claudeCandidate?.fastMode === true
      ? true
      : claudeCandidate?.fastMode === false
        ? false
        : undefined;
  const claude =
    claudeThinking !== undefined || claudeEffort !== undefined || claudeFastMode !== undefined
      ? {
          ...(claudeThinking !== undefined ? { thinking: claudeThinking } : {}),
          ...(claudeEffort !== undefined ? { effort: claudeEffort } : {}),
          ...(claudeFastMode !== undefined ? { fastMode: claudeFastMode } : {}),
        }
      : undefined;

  const factoryDroidEffort: "low" | "medium" | "high" | undefined =
    factoryDroidCandidate?.effort === "low" ||
    factoryDroidCandidate?.effort === "medium" ||
    factoryDroidCandidate?.effort === "high"
      ? factoryDroidCandidate.effort
      : undefined;
  const factoryDroid =
    factoryDroidEffort !== undefined ? { effort: factoryDroidEffort } : undefined;

  if (!codex && !claude && !factoryDroid) {
    return null;
  }
  return {
    ...(codex ? { codex } : {}),
    ...(claude ? { claudeAgent: claude } : {}),
    ...(factoryDroid ? { factoryDroid } : {}),
  };
}

export function normalizeModelSelection(
  value: unknown,
  legacy?: {
    provider?: unknown;
    model?: unknown;
    modelOptions?: unknown;
    legacyCodex?: LegacyCodexFields;
  },
): ModelSelection | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const provider = normalizeProviderKind(candidate?.provider ?? legacy?.provider);
  if (provider === null) {
    return null;
  }
  const rawModel = candidate?.model ?? legacy?.model;
  if (typeof rawModel !== "string") {
    return null;
  }
  const model = normalizeModelSlug(rawModel, provider);
  if (!model) {
    return null;
  }
  const modelOptions = normalizeProviderModelOptions(
    candidate?.options ? { [provider]: candidate.options } : legacy?.modelOptions,
    provider,
    provider === "codex" ? legacy?.legacyCodex : undefined,
  );
  const options = modelOptions?.[provider];
  return makeModelSelection(provider, model, options);
}

export function legacySyncModelSelectionOptions(
  modelSelection: ModelSelection | null,
  modelOptions: ProviderModelOptions | null | undefined,
): ModelSelection | null {
  if (modelSelection === null) {
    return null;
  }
  const options = modelOptions?.[modelSelection.provider];
  return makeModelSelection(modelSelection.provider, modelSelection.model, options);
}

export function legacyReplaceProviderModelOptions(
  currentModelOptions: ProviderModelOptions | null | undefined,
  provider: ProviderKind,
  nextProviderOptions: ProviderModelOptions[ProviderKind] | null | undefined,
): ProviderModelOptions | null {
  const { [provider]: _discardedProviderModelOptions, ...otherProviderModelOptions } =
    currentModelOptions ?? {};
  const normalizedNextProviderOptions = normalizeProviderModelOptions(
    { [provider]: nextProviderOptions },
    provider,
  );

  return normalizeProviderModelOptions({
    ...otherProviderModelOptions,
    ...(normalizedNextProviderOptions ? normalizedNextProviderOptions : {}),
  });
}

export function legacyMergeModelSelectionIntoProviderModelOptions(
  modelSelection: ModelSelection | null,
  currentModelOptions: ProviderModelOptions | null | undefined,
): ProviderModelOptions | null {
  if (modelSelection?.options === undefined) {
    return normalizeProviderModelOptions(currentModelOptions);
  }
  return legacyReplaceProviderModelOptions(
    normalizeProviderModelOptions(currentModelOptions),
    modelSelection.provider,
    modelSelection.options,
  );
}

export function legacyToModelSelectionByProvider(
  modelSelection: ModelSelection | null,
  modelOptions: ProviderModelOptions | null | undefined,
): Partial<Record<ProviderKind, ModelSelection>> {
  const result: Partial<Record<ProviderKind, ModelSelection>> = {};
  if (modelOptions) {
    for (const provider of ["codex", "claudeAgent", "factoryDroid"] as const) {
      const options = modelOptions[provider];
      if (options && Object.keys(options).length > 0) {
        result[provider] = makeModelSelection(
          provider,
          modelSelection?.provider === provider ? modelSelection.model : getDefaultModel(provider),
          options,
        );
      }
    }
  }
  if (modelSelection) {
    result[modelSelection.provider] = modelSelection;
  }
  return result;
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJson(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeJson(entry)]),
    );
  }
  return value;
}

export function sameModelSelection(
  left: ModelSelection | null | undefined,
  right: ModelSelection | null | undefined,
): boolean {
  if (left === right) return true;
  if (left == null || right == null) return left == null && right == null;
  if (left.provider !== right.provider || left.model !== right.model) return false;
  return (
    JSON.stringify(normalizeJson(left.options ?? null)) ===
    JSON.stringify(normalizeJson(right.options ?? null))
  );
}
