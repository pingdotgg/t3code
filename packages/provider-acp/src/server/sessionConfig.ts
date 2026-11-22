import type { ProviderOptionChoice, ProviderOptionDescriptor } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";

import { findModelConfigOption, type AcpSessionModeState } from "./runtimeModel.ts";

export const ACP_SESSION_MODE_OPTION_ID = "_t3/session-mode";
export const ACP_MAX_CATALOG_MODELS = 256;

/** Encodes a valid empty ACP choice as a non-empty T3 ID; map back before applying. */
export const ACP_EMPTY_OPTION_VALUE = "_t3/empty";

const MAX_OPTION_DESCRIPTORS = 16;
const MAX_OPTION_CHOICES = 64;
const MAX_TEXT_LENGTH = 256;
const MAX_MODEL_ID_LENGTH = 128;
const MAX_MODEL_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 1_024;

const boundedText = (value: string | null | undefined, maximumLength: number): string =>
  (value ?? "").trim().slice(0, maximumLength);

const boundedOpaqueValue = (value: string, maximumLength: number): string | undefined =>
  value.length > 0 && value === value.trim() && value.length <= maximumLength ? value : undefined;

const choiceId = (value: string): string | undefined =>
  value === "" ? ACP_EMPTY_OPTION_VALUE : boundedOpaqueValue(value, MAX_TEXT_LENGTH);

/** Mistral Vibe 3.1 sends its reasoning level under `thinking`, a category ACP reserves but never defined. */
export const isAcpThoughtLevelOption = (option: EffectAcpSchema.SessionConfigOption): boolean =>
  option.category === "thought_level" ||
  (option.category === "thinking" && option.type === "select");

export function flattenSelectChoices(
  options: EffectAcpSchema.SessionConfigSelectOptions,
): ReadonlyArray<EffectAcpSchema.SessionConfigSelectOption> {
  return options.flatMap((candidate) => ("value" in candidate ? [candidate] : candidate.options));
}

/**
 * Stable key for the effective model catalog advertised by a session, mirroring
 * normalization's 256-model cap and overflow-selected retention while ignoring
 * ordinary selection changes within the retained catalog.
 */
export function acpSessionCatalogKey(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): string {
  const modelOption = findModelConfigOption(configOptions);
  const kind = modelOption?.type === "select" ? "select" : "models";
  const selectedId =
    modelOption?.type === "select"
      ? boundedOpaqueValue(modelOption.currentValue, MAX_MODEL_ID_LENGTH)
      : modelState?.currentModelId === undefined
        ? undefined
        : boundedOpaqueValue(modelState.currentModelId, MAX_MODEL_ID_LENGTH);
  const candidates: ReadonlyArray<readonly [string, string, string | null]> =
    modelOption?.type === "select"
      ? flattenSelectChoices(modelOption.options).map((choice) => [
          choice.value,
          choice.name,
          choice.description ?? null,
        ])
      : (modelState?.availableModels ?? []).map((model) => [
          model.modelId,
          model.name,
          model.description ?? null,
        ]);
  const normalizeEntry = (
    id: string,
    candidate: readonly [string, string, string | null],
  ): readonly [string, string, string | null] => [
    id,
    boundedText(candidate[1], MAX_MODEL_NAME_LENGTH) || id,
    candidate[2] === null ? null : boundedText(candidate[2], MAX_DESCRIPTION_LENGTH) || null,
  ];
  const seen = new Set<string>();
  const retained: Array<readonly [string, string, string | null]> = [];
  for (const candidate of candidates) {
    if (retained.length === ACP_MAX_CATALOG_MODELS) break;
    const id = boundedOpaqueValue(candidate[0], MAX_MODEL_ID_LENGTH);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    retained.push(normalizeEntry(id, candidate));
  }
  if (
    selectedId !== undefined &&
    retained.length === ACP_MAX_CATALOG_MODELS &&
    !seen.has(selectedId)
  ) {
    const selected = candidates.find((candidate) => candidate[0] === selectedId);
    if (selected !== undefined) {
      retained[ACP_MAX_CATALOG_MODELS - 1] = normalizeEntry(selectedId, selected);
    }
  }
  return JSON.stringify([kind, retained]);
}

function selectChoices(
  candidates: ReadonlyArray<{
    readonly value: string;
    readonly name: string;
    readonly description?: string | null | undefined;
  }>,
): ReadonlyArray<ProviderOptionChoice> {
  const seen = new Set<string>();
  const choices: Array<ProviderOptionChoice> = [];
  for (const candidate of candidates) {
    const id = choiceId(candidate.value);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const description = boundedText(candidate.description, MAX_DESCRIPTION_LENGTH);
    choices.push({
      id,
      label: boundedText(candidate.name, MAX_TEXT_LENGTH) || id,
      ...(description ? { description } : {}),
    });
    if (choices.length === MAX_OPTION_CHOICES) break;
  }
  return choices;
}

export function acpProviderOptionDescriptors(input: {
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined;
  readonly modeState: AcpSessionModeState | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  const descriptors: Array<ProviderOptionDescriptor> = [];
  const seen = new Set<string>();
  const mirroredModeChoiceSets: Array<ReadonlySet<string>> = [];
  let hasModeCategory = false;

  for (const option of input.configOptions ?? []) {
    // Model and collaboration_mode choices use T3 model and interaction controls.
    if (option.category === "model" || option.category === "collaboration_mode") {
      continue;
    }
    const id = boundedOpaqueValue(option.id, MAX_TEXT_LENGTH);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const description = boundedText(option.description, MAX_DESCRIPTION_LENGTH);
    const base = {
      id,
      label: boundedText(option.name, MAX_TEXT_LENGTH) || id,
      ...(description ? { description } : {}),
    } as const;
    if (option.type === "boolean") {
      if (option.category === "mode") hasModeCategory = true;
      descriptors.push({
        ...base,
        type: "boolean",
        currentValue: option.currentValue,
      });
      if (descriptors.length === MAX_OPTION_DESCRIPTORS) return descriptors;
      continue;
    }
    const choices = selectChoices(flattenSelectChoices(option.options));
    if (choices.length === 0) {
      seen.delete(id);
      continue;
    }
    if (option.category === "mode") hasModeCategory = true;
    const isThoughtLevel = isAcpThoughtLevelOption(option);
    if (isThoughtLevel) {
      mirroredModeChoiceSets.push(new Set(choices.map((choice) => choice.id)));
    }
    const currentValue = choiceId(option.currentValue);
    descriptors.push({
      ...base,
      type: "select",
      options: choices,
      ...(currentValue && choices.some((choice) => choice.id === currentValue)
        ? { currentValue }
        : {}),
      ...(isThoughtLevel ? { role: "reasoning" as const } : {}),
    });
    if (descriptors.length === MAX_OPTION_DESCRIPTORS) return descriptors;
  }

  const modeState = input.modeState;
  if (modeState !== undefined && !hasModeCategory) {
    const choices = selectChoices(
      modeState.availableModes.map((mode) => ({
        value: mode.id,
        name: mode.name,
        description: mode.description,
      })),
    );
    const currentValue = choiceId(modeState.currentModeId);
    // Some agents duplicate modes in config options; show each control once.
    const duplicatesKnownModeDescriptor = mirroredModeChoiceSets.some(
      (choiceIds) =>
        choiceIds.size === choices.length && choices.every((choice) => choiceIds.has(choice.id)),
    );
    if (
      choices.length > 1 &&
      !duplicatesKnownModeDescriptor &&
      !seen.has(ACP_SESSION_MODE_OPTION_ID)
    ) {
      descriptors.push({
        id: ACP_SESSION_MODE_OPTION_ID,
        label: "Mode",
        description: "Session mode advertised by the ACP agent.",
        type: "select",
        options: choices,
        ...(currentValue && choices.some((choice) => choice.id === currentValue)
          ? { currentValue }
          : {}),
      });
    }
  }

  return descriptors.slice(0, MAX_OPTION_DESCRIPTORS);
}
