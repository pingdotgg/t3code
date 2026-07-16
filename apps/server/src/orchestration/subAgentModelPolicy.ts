import {
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { getProviderOptionCurrentValue, getProviderOptionDescriptors } from "@t3tools/shared/model";

const SUB_AGENT_TITLE_PATTERN = /^agent:\s*/i;
const FAST_MODE_OPTION_ID = "fastMode";
const SERVICE_TIER_OPTION_ID = "serviceTier";
const STANDARD_SERVICE_TIER_ID = "default";
const EFFORT_OPTION_IDS = new Set(["effort", "reasoningEffort", "reasoning"]);
const LUNA_MODELS = new Set(["claudex-luna", "gpt-5.6-luna"]);
const ALLOWED_CLAUDE_MODELS = new Set(["claude-sonnet-5", "claude-opus-4-8"]);
const ALLOWED_CODEX_MODELS = new Set(["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"]);
const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

export const EFFORT_RANK = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
  ultracode: 6,
} as const;

type Effort = keyof typeof EFFORT_RANK;
type ModelClamp = { readonly model: string; readonly reason: string };

export const MODEL_CLAMPS: Readonly<Record<string, ModelClamp>> = {
  "claudex-sol": { model: "claudex-luna", reason: "banned for sub-agents" },
  "gpt-5.6-sol": { model: "gpt-5.6-luna", reason: "banned for sub-agents" },
  "gpt-5.5": { model: "gpt-5.6-luna", reason: "outdated Codex generation" },
  "gpt-5.4": { model: "gpt-5.6-luna", reason: "outdated Codex generation" },
  "gpt-5.4-mini": { model: "gpt-5.6-luna", reason: "outdated Codex generation" },
  "gpt-5.3-codex": { model: "gpt-5.6-luna", reason: "outdated Codex generation" },
  "gpt-5.3-codex-spark": { model: "gpt-5.6-luna", reason: "outdated Codex generation" },
  "gpt-5.2": { model: "gpt-5.6-luna", reason: "outdated Codex generation" },
  "gpt-5-codex": { model: "gpt-5.6-luna", reason: "outdated Codex generation" },
  "claude-fable-5": { model: "claude-opus-4-8", reason: "banned for sub-agents" },
  "claude-opus-4-7": { model: "claude-opus-4-8", reason: "outdated Claude generation" },
  "claude-opus-4-6": { model: "claude-opus-4-8", reason: "outdated Claude generation" },
  "claude-opus-4-5": { model: "claude-opus-4-8", reason: "outdated Claude generation" },
  "claude-haiku-4-5": { model: "claude-sonnet-5", reason: "banned as a sub-agent model" },
  "claude-sonnet-4-6": { model: "claude-sonnet-5", reason: "outdated Claude generation" },
};

const normalizeModel = (model: string): string => model.trim().toLowerCase();

const isOutdatedGpt5 = (model: string): boolean =>
  model.startsWith("gpt-5") && !model.startsWith("gpt-5.6");

const isBannedModel = (model: string): boolean =>
  Object.prototype.hasOwnProperty.call(MODEL_CLAMPS, model) || isOutdatedGpt5(model);

const isAllowedCatalogModel = (model: string): boolean => {
  const normalized = normalizeModel(model);
  if (isBannedModel(normalized)) return false;
  if (normalized.startsWith("claudex-") && normalized !== "claudex-luna") return false;
  if (normalized.startsWith("claude-") && !ALLOWED_CLAUDE_MODELS.has(normalized)) return false;
  return true;
};

const resolveUnknownModelClamp = (input: {
  readonly driver: ProviderDriverKind;
  readonly model: string;
}): ModelClamp | undefined => {
  const normalized = normalizeModel(input.model);
  const direct = MODEL_CLAMPS[normalized];
  if (direct) return direct;
  if (isOutdatedGpt5(normalized)) {
    return { model: "gpt-5.6-luna", reason: "outdated Codex generation" };
  }
  if (normalized.startsWith("claudex-") && normalized !== "claudex-luna") {
    return { model: "claudex-luna", reason: "unknown Claudex slug fallback" };
  }
  if (normalized.startsWith("claude-") && !ALLOWED_CLAUDE_MODELS.has(normalized)) {
    return { model: "claude-sonnet-5", reason: "unknown Claude slug fallback" };
  }
  if (input.driver === CODEX_DRIVER_KIND && !ALLOWED_CODEX_MODELS.has(normalized)) {
    return { model: "gpt-5.6-luna", reason: "unknown Codex slug fallback" };
  }
  return undefined;
};

const effortCapForModel = (model: string): Effort =>
  LUNA_MODELS.has(normalizeModel(model)) ? "xhigh" : "high";

const rankedEffort = (value: unknown): value is Effort =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(EFFORT_RANK, value);

const isPromptInjectedEffort = (
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | undefined,
  value: unknown,
): boolean =>
  typeof value === "string" &&
  !rankedEffort(value) &&
  descriptor?.promptInjectedValues?.includes(value) === true;

const highestDescriptorValueAtOrBelowCap = (
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | undefined,
  cap: Effort,
): string => {
  const candidates =
    descriptor?.options
      .filter((option) => !descriptor.promptInjectedValues?.includes(option.id))
      .filter((option) => rankedEffort(option.id) && EFFORT_RANK[option.id] <= EFFORT_RANK[cap])
      .toSorted(
        (left, right) => EFFORT_RANK[right.id as Effort] - EFFORT_RANK[left.id as Effort],
      ) ?? [];
  return candidates[0]?.id ?? cap;
};

const setEffortOption = (selection: ModelSelection, id: string, value: string): ModelSelection => {
  const options = [...(selection.options ?? [])];
  const index = options.findIndex((option) => EFFORT_OPTION_IDS.has(option.id));
  if (index >= 0) {
    options[index] = { ...options[index]!, value };
  } else {
    options.push({ id, value });
  }
  return { ...selection, options };
};

const clampEffort = (input: {
  readonly selection: ModelSelection;
  readonly capabilities?: ModelCapabilities;
  readonly notices?: Array<string>;
}): ModelSelection => {
  const { selection, capabilities, notices } = input;
  const cap = effortCapForModel(selection.model);
  const rawEffort = selection.options?.find((option) => EFFORT_OPTION_IDS.has(option.id));
  const descriptors = capabilities
    ? getProviderOptionDescriptors({ caps: capabilities, selections: selection.options })
    : [];
  const descriptor = descriptors.find(
    (candidate): candidate is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      candidate.type === "select" && EFFORT_OPTION_IDS.has(candidate.id),
  );
  const rawValue = rawEffort?.value;
  const descriptorValue = getProviderOptionCurrentValue(descriptor);
  const promptInjected = isPromptInjectedEffort(descriptor, rawValue ?? descriptorValue);
  const hasExplicitEffort = rawEffort !== undefined && !promptInjected;
  const currentValue = hasExplicitEffort ? rawValue : promptInjected ? undefined : descriptorValue;

  let nextValue: string | undefined;
  if (LUNA_MODELS.has(normalizeModel(selection.model)) && !hasExplicitEffort && !promptInjected) {
    nextValue = "xhigh";
  } else if (
    !promptInjected &&
    rankedEffort(currentValue) &&
    EFFORT_RANK[currentValue] > EFFORT_RANK[cap]
  ) {
    nextValue = highestDescriptorValueAtOrBelowCap(descriptor, cap);
  }

  if (nextValue === undefined) return selection;
  if (hasExplicitEffort && currentValue === nextValue) return selection;

  const optionId = rawEffort?.id ?? descriptor?.id ?? "effort";
  if (notices) {
    const displayedCurrent = currentValue ?? "default";
    notices.push(`effort ${displayedCurrent} → ${nextValue} (sub-agent cap)`);
  }
  return setEffortOption(selection, optionId, nextValue);
};

export const isSubAgentThreadTitle = (title: string): boolean =>
  SUB_AGENT_TITLE_PATTERN.test(title.trim());

export const withSubAgentThreadTitle = (title: string): string => {
  const name = title.trim().replace(SUB_AGENT_TITLE_PATTERN, "").trim();
  return `Agent: ${name}`;
};

/**
 * Product-native sub-agent threads always use the standard service tier.
 * Apply this at the orchestration boundary as well as at spawn time so a
 * client cannot re-enable fast mode on a child thread through metadata or a
 * per-turn model selection.
 */
export const enforceSubAgentStandardMode = (selection: ModelSelection): ModelSelection => {
  let changed = false;
  const options = selection.options?.map((option) => {
    if (option.id === FAST_MODE_OPTION_ID && option.value !== false) {
      changed = true;
      return { ...option, value: false };
    }
    if (option.id === SERVICE_TIER_OPTION_ID && option.value !== STANDARD_SERVICE_TIER_ID) {
      changed = true;
      return { ...option, value: STANDARD_SERVICE_TIER_ID };
    }
    return option;
  });

  return changed && options !== undefined ? { ...selection, options } : selection;
};

/** Clamp only effort for a child-thread model selection at orchestration boundaries. */
export const clampSubAgentEffortByModel = (selection: ModelSelection): ModelSelection =>
  clampEffort({ selection });

export interface SubAgentModelResolution {
  readonly model: string;
  readonly notices: ReadonlyArray<string>;
}

/** Resolve a requested child model before constructing model-specific options. */
export const resolveSubAgentModel = (args: {
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly availableModels: ReadonlyArray<string>;
}): SubAgentModelResolution => {
  const requestedModel = args.model.trim();
  const clamp = resolveUnknownModelClamp({ driver: args.driver, model: requestedModel });
  const notices: Array<string> = [];
  let effectiveModel = requestedModel;

  if (clamp && normalizeModel(clamp.model) !== normalizeModel(requestedModel)) {
    const replacement = args.availableModels.find(
      (candidate) => normalizeModel(candidate) === normalizeModel(clamp.model),
    );
    if (replacement !== undefined) {
      effectiveModel = replacement;
      notices.push(`model ${requestedModel} → ${effectiveModel} (${clamp.reason})`);
    } else {
      const fallback = args.availableModels.find(isAllowedCatalogModel);
      if (fallback !== undefined) {
        effectiveModel = fallback;
        notices.push(
          `model ${requestedModel} → ${effectiveModel} (${clamp.model} unavailable; using an allowed catalog model)`,
        );
      } else {
        notices.push(
          `model ${requestedModel} kept (${clamp.model} unavailable; provider catalog is advisory)`,
        );
      }
    }
  }

  return { model: effectiveModel, notices };
};

export const applySubAgentModelPolicy = (args: {
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly availableModels: ReadonlyArray<string>;
  readonly selection: ModelSelection;
  /** Resolve capabilities from the model after model clamping. */
  readonly capabilitiesFor?: (model: string) => ModelCapabilities | undefined;
  /** Precomputed model resolution when the caller already clamped the model. */
  readonly modelResolution?: SubAgentModelResolution;
}): {
  readonly model: string;
  readonly selection: ModelSelection;
  readonly notices: ReadonlyArray<string>;
} => {
  const modelResolution =
    args.modelResolution ??
    resolveSubAgentModel({
      driver: args.driver,
      model: args.model,
      availableModels: args.availableModels,
    });
  const notices = [...modelResolution.notices];
  let selection =
    normalizeModel(args.selection.model) === normalizeModel(modelResolution.model)
      ? args.selection
      : { ...args.selection, model: modelResolution.model };
  const standardized = enforceSubAgentStandardMode(selection);
  if (standardized !== selection) {
    const before = new Map((selection.options ?? []).map((option) => [option.id, option.value]));
    for (const option of standardized.options ?? []) {
      if (
        (option.id === FAST_MODE_OPTION_ID || option.id === SERVICE_TIER_OPTION_ID) &&
        before.get(option.id) !== option.value
      ) {
        notices.push(`option ${option.id} forced to standard sub-agent mode`);
      }
    }
  }
  selection = standardized;
  const capabilities = args.capabilitiesFor?.(modelResolution.model);
  selection = clampEffort({
    selection,
    ...(capabilities !== undefined ? { capabilities } : {}),
    notices,
  });

  return {
    model: modelResolution.model,
    selection,
    notices,
  };
};
