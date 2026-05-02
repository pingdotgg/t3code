import { ProviderInstanceId, ServerSettings, type ServerSettingsPatch } from "@t3tools/contracts";
import { Schema } from "effect";
import { deepMerge } from "./Struct.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { createModelSelection } from "./model.ts";

const ServerSettingsJson = fromLenientJson(ServerSettings);

type ServerSettingsPatchBase = Omit<ServerSettings, "textGenerationModelSelection"> & {
  readonly textGenerationModelSelection: {
    readonly instanceId?: string | undefined;
    readonly model: string;
    readonly options?:
      | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
      | Readonly<Record<string, unknown>>
      | undefined;
  };
};

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
    const decoded = Schema.decodeUnknownSync(ServerSettingsJson)(raw);
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

function mergeModelSelectionOptionsById(input: {
  current:
    | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
    | Readonly<Record<string, unknown>>
    | undefined;
  patch:
    | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
    | Readonly<Record<string, unknown>>
    | undefined;
}): Array<{ id: string; value: string | boolean }> | undefined {
  const normalize = (
    options:
      | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
      | Readonly<Record<string, unknown>>
      | undefined,
  ) =>
    Array.isArray(options)
      ? options
      : Object.entries(options ?? {}).flatMap(([id, value]) =>
          typeof value === "string" || typeof value === "boolean" ? [{ id, value }] : [],
        );
  if (input.patch === undefined) {
    const current = normalize(input.current);
    return current.length > 0 ? [...current] : undefined;
  }
  const patch = normalize(input.patch);
  if (patch.length === 0) {
    return undefined;
  }

  const merged = new Map(
    normalize(input.current).map((selection) => [selection.id, selection.value]),
  );
  for (const selection of patch) {
    merged.set(selection.id, selection.value);
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

/**
 * Applies a server settings patch while treating textGenerationModelSelection as
 * replace-on-provider/model updates. This prevents stale nested options from
 * surviving a reset patch that intentionally omits options.
 */
export function applyServerSettingsPatch(
  current: ServerSettingsPatchBase,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const next = deepMerge(current, patch);
  const nextWithReplacements =
    patch.providerInstances !== undefined
      ? {
          ...next,
          providerInstances: patch.providerInstances,
        }
      : next;
  if (!selectionPatch) {
    return nextWithReplacements as ServerSettings;
  }

  const instanceId =
    selectionPatch.instanceId ??
    current.textGenerationModelSelection.instanceId ??
    ProviderInstanceId.make("codex");
  const model = selectionPatch.model ?? current.textGenerationModelSelection.model;
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : mergeModelSelectionOptionsById({
        current: current.textGenerationModelSelection.options,
        patch: selectionPatch.options,
      });

  return {
    ...(nextWithReplacements as ServerSettings),
    textGenerationModelSelection: createModelSelection(
      ProviderInstanceId.make(instanceId),
      model,
      options,
    ) as ServerSettings["textGenerationModelSelection"],
  };
}
