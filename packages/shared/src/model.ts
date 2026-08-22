import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
} from "@t3tools/contracts";

const DEFAULT_PROVIDER_DRIVER_KIND = ProviderDriverKind.make("codex");

export interface SelectableModelOption {
  slug: string;
  name: string;
}

export function createModelCapabilities(input: {
  optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
}): ModelCapabilities {
  return {
    optionDescriptors: input.optionDescriptors.map(cloneDescriptor),
  };
}

function getRawSelectionValueById(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | boolean | undefined {
  const selection = selections?.find((candidate) => candidate.id === id);
  return selection?.value;
}

export function getProviderOptionSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | boolean | undefined {
  return getRawSelectionValueById(selections, id);
}

export function getProviderOptionStringSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | undefined {
  const value = getProviderOptionSelectionValue(selections, id);
  return typeof value === "string" ? value : undefined;
}

export function getProviderOptionBooleanSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): boolean | undefined {
  const value = getProviderOptionSelectionValue(selections, id);
  return typeof value === "boolean" ? value : undefined;
}

export function getModelSelectionOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string,
): string | boolean | undefined {
  return getProviderOptionSelectionValue(modelSelection?.options, id);
}

export function getModelSelectionStringOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string,
): string | undefined {
  return getProviderOptionStringSelectionValue(modelSelection?.options, id);
}

export function getModelSelectionBooleanOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string,
): boolean | undefined {
  return getProviderOptionBooleanSelectionValue(modelSelection?.options, id);
}

function resolveDescriptorChoiceValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
  raw: string | null | undefined,
): string | undefined {
  const trimmed = trimOrNull(raw);
  if (!trimmed) {
    return descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
  }
  if (descriptor.options.length === 0) {
    return trimmed;
  }
  if (
    descriptor.promptInjectedValues?.includes(trimmed) &&
    descriptor.options.some((option) => option.id === trimmed)
  ) {
    return descriptor.options.find((option) => option.isDefault)?.id;
  }
  if (descriptor.options.some((option) => option.id === trimmed)) {
    return trimmed;
  }
  return descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
}

function cloneDescriptor(descriptor: ProviderOptionDescriptor): ProviderOptionDescriptor {
  return descriptor.type === "select"
    ? {
        ...descriptor,
        options: [...descriptor.options],
        ...(descriptor.promptInjectedValues
          ? { promptInjectedValues: [...descriptor.promptInjectedValues] }
          : {}),
      }
    : { ...descriptor };
}

function cloneSelection(selection: ProviderOptionSelection): ProviderOptionSelection {
  return { ...selection };
}

function withDescriptorCurrentValue(
  descriptor: ProviderOptionDescriptor,
  rawCurrentValue: string | boolean | undefined,
): ProviderOptionDescriptor {
  if (descriptor.type === "boolean") {
    if (typeof rawCurrentValue === "boolean") {
      return {
        ...descriptor,
        currentValue: rawCurrentValue,
      };
    }
    return descriptor;
  }
  const currentValue =
    typeof rawCurrentValue === "string"
      ? resolveDescriptorChoiceValue(descriptor, rawCurrentValue)
      : resolveDescriptorChoiceValue(descriptor, descriptor.currentValue);
  if (!currentValue) {
    const { currentValue: _unusedCurrentValue, ...rest } = descriptor;
    return rest;
  }
  return {
    ...descriptor,
    currentValue,
  };
}

export function getProviderOptionDescriptors(input: {
  caps: ModelCapabilities;
  selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  const { caps, selections } = input;
  const baseDescriptors = (caps.optionDescriptors ?? []).map(cloneDescriptor);

  return baseDescriptors.map((descriptor) =>
    withDescriptorCurrentValue(
      descriptor,
      getRawSelectionValueById(selections, descriptor.id) ?? descriptor.currentValue,
    ),
  );
}

export function getProviderOptionCurrentValue(
  descriptor: ProviderOptionDescriptor | null | undefined,
): string | boolean | undefined {
  if (!descriptor) {
    return undefined;
  }
  if (descriptor.type === "boolean") {
    return descriptor.currentValue;
  }
  if (descriptor.currentValue) {
    return descriptor.currentValue;
  }
  return descriptor.options.find((option) => option.isDefault)?.id;
}

export function getProviderOptionCurrentLabel(
  descriptor: ProviderOptionDescriptor | null | undefined,
): string | undefined {
  if (!descriptor) {
    return undefined;
  }
  if (descriptor.type === "boolean") {
    return typeof descriptor.currentValue === "boolean"
      ? descriptor.currentValue
        ? "On"
        : "Off"
      : undefined;
  }
  const currentValue = getProviderOptionCurrentValue(descriptor);
  if (typeof currentValue !== "string") {
    return undefined;
  }
  return descriptor.options.find((option) => option.id === currentValue)?.label;
}

export function buildProviderOptionSelectionsFromDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined,
): Array<ProviderOptionSelection> | undefined {
  if (!descriptors || descriptors.length === 0) {
    return undefined;
  }

  const nextSelections: Array<ProviderOptionSelection> = [];

  for (const descriptor of descriptors) {
    const value = getProviderOptionCurrentValue(descriptor);
    if (typeof value === "string" || typeof value === "boolean") {
      nextSelections.push({ id: descriptor.id, value });
    }
  }

  return nextSelections.length > 0 ? nextSelections : undefined;
}

export function getModelSelectionOptionDescriptors(
  modelSelection: ModelSelection | null | undefined,
  caps?: ModelCapabilities | null | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  if (!modelSelection) {
    return [];
  }
  if (!caps) {
    return [];
  }
  return getProviderOptionDescriptors({
    caps,
    selections: modelSelection.options,
  });
}

export function isClaudeUltrathinkPrompt(text: string | null | undefined): boolean {
  return typeof text === "string" && /\bultrathink\b/i.test(text);
}

export type ReasoningTransitionAction =
  | { type: "cycle"; direction: "increase" | "decrease" }
  | { type: "select"; descriptorId: string; value: string };

export type ReasoningTransitionResult =
  | {
      status: "changed";
      prompt: string;
      modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
      value: string;
      label: string;
    }
  | { status: "unchanged" }
  | { status: "blocked"; reason: "ultrathink-in-prompt-body" }
  | {
      status: "unsupported";
      reason: "missing-reasoning-option" | "missing-choices" | "unsupported-prompt-injected-value";
    }
  | { status: "not-applicable" }
  | { status: "invalid"; reason: "unknown-value" };

const REASONING_DESCRIPTOR_IDS = new Set(["reasoningEffort", "effort", "reasoning"]);
const ULTRATHINK_VALUE = "ultrathink";
const ULTRATHINK_PREFIX = "Ultrathink:\n";
const LEADING_ULTRATHINK_PREFIX = /^Ultrathink:(?:\r?\n)?/i;

function findReasoningDescriptor(
  capabilities: ModelCapabilities,
): Extract<ProviderOptionDescriptor, { type: "select" }> | undefined {
  return (capabilities.optionDescriptors ?? []).find(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select" && REASONING_DESCRIPTOR_IDS.has(descriptor.id),
  );
}

function providerSelectionsEqual(
  left: ReadonlyArray<ProviderOptionSelection> | undefined,
  right: ReadonlyArray<ProviderOptionSelection> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every(
    (selection, index) =>
      selection.id === right[index]?.id && selection.value === right[index]?.value,
  );
}

function resolvePersistedReasoningValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): string | undefined {
  const selected = getProviderOptionStringSelectionValue(modelOptions, descriptor.id);
  const candidates = [
    selected,
    descriptor.currentValue,
    descriptor.options.find((option) => option.isDefault)?.id,
  ];
  return candidates.find(
    (candidate) =>
      candidate !== undefined &&
      descriptor.options.some((option) => option.id === candidate) &&
      !descriptor.promptInjectedValues?.includes(candidate),
  );
}

function updateReasoningSelection(
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  descriptorId: string,
  value: string,
): ReadonlyArray<ProviderOptionSelection> {
  const current = modelOptions ?? [];
  const index = current.findIndex((selection) => selection.id === descriptorId);
  if (index === -1) {
    return [...current, { id: descriptorId, value }];
  }
  if (current[index]?.value === value) {
    return current;
  }
  return current.map((selection, selectionIndex) =>
    selectionIndex === index ? { ...selection, value } : selection,
  );
}

function removePromptInjectedReasoningSelection(
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (!modelOptions) return undefined;
  const selection = modelOptions.find((candidate) => candidate.id === descriptor.id);
  if (
    typeof selection?.value !== "string" ||
    !descriptor.promptInjectedValues?.includes(selection.value)
  ) {
    return modelOptions;
  }
  const next = modelOptions.filter((candidate) => candidate !== selection);
  return next.length > 0 ? next : undefined;
}

export function resolveReasoningTransition(input: {
  capabilities: ModelCapabilities;
  modelOptions?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  prompt: string;
  action: ReasoningTransitionAction;
}): ReasoningTransitionResult {
  const { capabilities, modelOptions, prompt, action } = input;
  if (action.type === "select" && !REASONING_DESCRIPTOR_IDS.has(action.descriptorId)) {
    return { status: "not-applicable" };
  }

  const descriptor = findReasoningDescriptor(capabilities);
  if (!descriptor || (action.type === "select" && action.descriptorId !== descriptor.id)) {
    return { status: "unsupported", reason: "missing-reasoning-option" };
  }
  if (descriptor.options.length === 0) {
    return { status: "unsupported", reason: "missing-choices" };
  }

  const promptInjectedUltrathink =
    descriptor.promptInjectedValues?.includes(ULTRATHINK_VALUE) ?? false;
  const leadingPrefixMatch = promptInjectedUltrathink
    ? prompt.match(LEADING_ULTRATHINK_PREFIX)
    : null;
  const promptBody = leadingPrefixMatch ? prompt.slice(leadingPrefixMatch[0].length) : prompt;
  const ultrathinkInBody = promptInjectedUltrathink && isClaudeUltrathinkPrompt(promptBody);
  const promptControlsUltrathink =
    promptInjectedUltrathink && (leadingPrefixMatch !== null || ultrathinkInBody);
  const persistedValue = resolvePersistedReasoningValue(descriptor, modelOptions);
  const rawPersistedValue = getProviderOptionStringSelectionValue(modelOptions, descriptor.id);
  const persistedPromptInjectedValue =
    rawPersistedValue !== undefined &&
    (descriptor.promptInjectedValues?.includes(rawPersistedValue) ?? false);
  const currentValue = promptControlsUltrathink ? ULTRATHINK_VALUE : persistedValue;

  let targetValue: string;
  if (action.type === "select") {
    if (!descriptor.options.some((option) => option.id === action.value)) {
      return { status: "invalid", reason: "unknown-value" };
    }
    targetValue = action.value;
  } else if (currentValue === undefined) {
    const fallbackIndex = action.direction === "increase" ? 0 : descriptor.options.length - 1;
    targetValue = descriptor.options[fallbackIndex]?.id ?? "";
  } else {
    const currentIndex = descriptor.options.findIndex((option) => option.id === currentValue);
    const offset = action.direction === "increase" ? 1 : -1;
    const targetIndex =
      currentIndex === -1
        ? action.direction === "increase"
          ? 0
          : descriptor.options.length - 1
        : (currentIndex + offset + descriptor.options.length) % descriptor.options.length;
    targetValue = descriptor.options[targetIndex]?.id ?? "";
  }

  if (ultrathinkInBody && targetValue !== ULTRATHINK_VALUE) {
    return { status: "blocked", reason: "ultrathink-in-prompt-body" };
  }

  const targetOption = descriptor.options.find((option) => option.id === targetValue);
  if (!targetOption) {
    return { status: "invalid", reason: "unknown-value" };
  }

  const targetIsPromptInjected = descriptor.promptInjectedValues?.includes(targetValue) ?? false;
  if (targetIsPromptInjected && targetValue !== ULTRATHINK_VALUE) {
    return { status: "unsupported", reason: "unsupported-prompt-injected-value" };
  }
  const nextPrompt = targetIsPromptInjected
    ? leadingPrefixMatch || ultrathinkInBody
      ? prompt
      : `${ULTRATHINK_PREFIX}${prompt}`
    : leadingPrefixMatch
      ? promptBody
      : prompt;
  const nextModelOptions = targetIsPromptInjected
    ? removePromptInjectedReasoningSelection(modelOptions, descriptor)
    : targetValue === persistedValue && !persistedPromptInjectedValue
      ? (modelOptions ?? undefined)
      : updateReasoningSelection(modelOptions, descriptor.id, targetValue);
  const normalizedInputOptions = modelOptions ?? undefined;

  if (nextPrompt === prompt && providerSelectionsEqual(nextModelOptions, normalizedInputOptions)) {
    return { status: "unchanged" };
  }

  return {
    status: "changed",
    prompt: nextPrompt,
    modelOptions: nextModelOptions,
    value: targetValue,
    label: targetOption.label,
  };
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderDriverKind = DEFAULT_PROVIDER_DRIVER_KIND,
): string | null {
  const trimmed = normalizeCustomModelSlug(model);
  if (!trimmed) {
    return null;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] ?? {};
  const aliased = Object.prototype.hasOwnProperty.call(aliases, trimmed)
    ? aliases[trimmed]
    : undefined;
  return typeof aliased === "string" ? aliased : trimmed;
}

/** Custom model identifiers are provider-owned, so only trim them; never expand aliases. */
export function normalizeCustomModelSlug(model: string | null | undefined): string | null {
  if (typeof model !== "string") {
    return null;
  }

  return model.trim() || null;
}

export function resolveSelectableModel(
  provider: ProviderDriverKind,
  value: string | null | undefined,
  options: ReadonlyArray<SelectableModelOption>,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = options.find((option) => option.slug === trimmed);
  if (direct) {
    return direct.slug;
  }

  const byName = options.find((option) => option.name.toLowerCase() === trimmed.toLowerCase());
  if (byName) {
    return byName.slug;
  }

  const normalized = normalizeModelSlug(trimmed, provider);
  if (!normalized) {
    return null;
  }

  const resolved = options.find((option) => option.slug === normalized);
  return resolved ? resolved.slug : null;
}

function resolveModelSlug(model: string | null | undefined, provider: ProviderDriverKind): string {
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
  }
  return normalized;
}

export function resolveModelSlugForProvider(
  provider: ProviderDriverKind,
  model: string | null | undefined,
): string {
  return resolveModelSlug(model, provider);
}

/** Trim a string, returning null for empty/missing values. */
export function trimOrNull<T extends string>(value: T | null | undefined): T | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim() as T;
  return trimmed || null;
}

function cloneSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
): Array<ProviderOptionSelection> {
  return selections.map(cloneSelection);
}

export function createModelSelection(
  instanceId: ProviderInstanceId,
  model: string,
  options?: ReadonlyArray<ProviderOptionSelection> | null,
): ModelSelection {
  const selections = options ? cloneSelections(options) : [];
  const base: ModelSelection = {
    instanceId,
    model,
  };
  return selections.length > 0 ? { ...base, options: selections } : base;
}

/**
 * Returns the effort value if it is a prompt-injected value according to
 * any select descriptor in the given capabilities, or null otherwise.
 *
 * Unlike a single `find`, this checks every descriptor so that the
 * correct descriptor's `promptInjectedValues` list is consulted even when
 * multiple select descriptors exist.
 */
export function resolvePromptInjectedEffort(
  caps: ModelCapabilities,
  rawEffort: string | null | undefined,
): string | null {
  const trimmed = trimOrNull(rawEffort);
  if (!trimmed) return null;
  const descriptors = getProviderOptionDescriptors({ caps });
  for (const descriptor of descriptors) {
    if (descriptor.type === "select" && descriptor.promptInjectedValues?.includes(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

export function applyClaudePromptEffortPrefix(
  text: string,
  effort: string | null | undefined,
): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (effort !== "ultrathink") {
    return trimmed;
  }
  if (trimmed.startsWith("Ultrathink:")) {
    return trimmed;
  }
  return `Ultrathink:\n${trimmed}`;
}
