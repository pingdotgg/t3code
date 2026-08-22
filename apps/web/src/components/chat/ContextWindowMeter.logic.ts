import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { getTriggerDisplayModelName, type ModelEsque } from "./providerIconUtils";

export function resolveContextWindowModelDisplayName(
  selection: ModelSelection | null | undefined,
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
): string | null {
  if (!selection) {
    return null;
  }

  const selectedModel = modelOptionsByInstance
    .get(selection.instanceId)
    ?.find((model) => model.slug === selection.model);

  return selectedModel ? getTriggerDisplayModelName(selectedModel) : selection.model;
}

export function formatContextWindowCompactionMessage(
  modelDisplayName: string | null | undefined,
): string {
  return modelDisplayName
    ? `Context for ${modelDisplayName} compacts automatically when needed.`
    : "Context compacts automatically when needed.";
}

/**
 * Absolute used-token thresholds for context severity. They track where agents
 * start losing the plot, which happens at roughly the same absolute sizes no
 * matter how large a window the model advertises - so the model's own context
 * limit deliberately plays no part in the banding.
 */
const SEVERITY_ORANGE_TOKENS = 160_000;

/** At and above this, context is bad enough to also earn a warning glyph. */
export const CONTEXT_WINDOW_CRITICAL_TOKENS = 250_000;

/**
 * Theme color for the meter's count and progress stroke, in three discrete
 * bands: green below 160k used tokens, orange up to 250k, red from there up.
 * The theme's warning token is amber rather than a true orange, so the middle
 * band is a fixed half-blend toward error.
 */
export function contextWindowSeverityColor(usedTokens: number | null): string {
  const tokens = typeof usedTokens === "number" && Number.isFinite(usedTokens) ? usedTokens : 0;

  if (tokens >= CONTEXT_WINDOW_CRITICAL_TOKENS) {
    return "var(--color-error)";
  }
  if (tokens >= SEVERITY_ORANGE_TOKENS) {
    return "color-mix(in oklab, var(--color-warning) 50%, var(--color-error))";
  }
  return "var(--color-success)";
}
