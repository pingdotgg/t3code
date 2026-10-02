import { ServerSettings, type ServerSettingsPatch } from "@t3tools/contracts";
import { Schema } from "effect";
import { deepMerge } from "./Struct.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { createModelSelection } from "./model.ts";

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownSync(ServerSettingsJson);

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}

export function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  try {
    const decoded = decodeServerSettingsJson(raw);
    return extractPersistedServerObservabilitySettings(decoded);
  } catch {
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
  }
}

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.instanceId !== undefined || patch.model !== undefined));
}

function shouldReplaceDelegatedThreadModelSelection(
  patch: ServerSettingsPatch["delegatedThreadModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.instanceId !== undefined || patch.model !== undefined));
}

function mergeModelSelectionOptionsById(input: {
  current: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
  patch: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
}): Array<{ id: string; value: string | boolean }> | undefined {
  if (input.patch === undefined) {
    return input.current ? [...input.current] : undefined;
  }
  if (input.patch.length === 0) {
    return undefined;
  }

  const merged = new Map((input.current ?? []).map((selection) => [selection.id, selection.value]));
  for (const selection of input.patch) {
    merged.set(selection.id, selection.value);
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

function applyProviderInstanceMutations(
  settings: ServerSettings,
  mutations: ServerSettingsPatch["providerInstanceMutations"],
): ServerSettings {
  if (mutations === undefined || mutations.length === 0) {
    return settings;
  }
  const providerInstances = { ...settings.providerInstances };
  for (const mutation of mutations) {
    if (mutation.config === null) {
      delete providerInstances[mutation.instanceId];
    } else {
      providerInstances[mutation.instanceId] = mutation.config;
    }
  }
  return { ...settings, providerInstances };
}

/**
 * Applies a server settings patch while treating textGenerationModelSelection and
 * delegatedThreadModelSelection as replace-on-provider/model updates. This prevents
 * stale nested options from surviving a reset patch that intentionally omits options.
 * defaultModelSelection is always a wholesale replace (including null to clear) so
 * a saved selection without options cannot inherit options from a previous value.
 */
export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const delegatedPatch = patch.delegatedThreadModelSelection;
  const { providerInstanceMutations, defaultModelSelection, ...mergeablePatch } = patch;
  const next = deepMerge(current, mergeablePatch);
  const nextWithDefault =
    defaultModelSelection !== undefined ? { ...next, defaultModelSelection } : next;
  const nextWithReplacements =
    patch.providerInstances !== undefined
      ? {
          ...nextWithDefault,
          providerInstances: patch.providerInstances,
        }
      : nextWithDefault;
  const withTextGeneration = !selectionPatch
    ? nextWithReplacements
    : (() => {
        const instanceId =
          selectionPatch.instanceId ?? current.textGenerationModelSelection.instanceId;
        const model = selectionPatch.model ?? current.textGenerationModelSelection.model;
        const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
          ? selectionPatch.options
          : mergeModelSelectionOptionsById({
              current: current.textGenerationModelSelection.options,
              patch: selectionPatch.options,
            });
        return {
          ...nextWithReplacements,
          textGenerationModelSelection: createModelSelection(instanceId, model, options),
        };
      })();
  if (!delegatedPatch) {
    return applyProviderInstanceMutations(withTextGeneration, providerInstanceMutations);
  }

  const delegatedInstanceId =
    delegatedPatch.instanceId ?? current.delegatedThreadModelSelection.instanceId;
  const delegatedModel = delegatedPatch.model ?? current.delegatedThreadModelSelection.model;
  const delegatedOptions = shouldReplaceDelegatedThreadModelSelection(delegatedPatch)
    ? delegatedPatch.options
    : mergeModelSelectionOptionsById({
        current: current.delegatedThreadModelSelection.options,
        patch: delegatedPatch.options,
      });

  return applyProviderInstanceMutations(
    {
      ...withTextGeneration,
      delegatedThreadModelSelection: createModelSelection(
        delegatedInstanceId,
        delegatedModel,
        delegatedOptions,
      ),
    },
    providerInstanceMutations,
  );
}
