import { ServerSettings, type ServerSettingsPatch } from "@t3tools/contracts";
import { Schema } from "effect";
import { deepMerge } from "./Struct";
import { fromLenientJson } from "./schemaJson";

const ServerSettingsJson = fromLenientJson(ServerSettings);

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
  return Boolean(patch && (patch.provider !== undefined || patch.model !== undefined));
}

/**
 * Applies a server settings patch while treating textGenerationModelSelection as
 * replace-on-provider/model updates. This prevents stale nested options from
 * surviving a reset patch that intentionally omits options.
 */
export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const next = deepMerge(current, patch);
  if (!selectionPatch || !shouldReplaceTextGenerationModelSelection(selectionPatch)) {
    return next;
  }

  return {
    ...next,
    textGenerationModelSelection: {
      provider: selectionPatch.provider ?? current.textGenerationModelSelection.provider,
      model: selectionPatch.model ?? current.textGenerationModelSelection.model,
      ...(selectionPatch.options ? { options: selectionPatch.options } : {}),
    },
  };
}
