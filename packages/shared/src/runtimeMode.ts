import { DEFAULT_RUNTIME_MODE, type RuntimeMode } from "@t3tools/contracts";

/**
 * Canonical priority for a new thread's runtime/access mode once the caller
 * has decided whether a carry source is eligible (same project only):
 * explicit draft pick > same-project carry > project sticky > configured
 * machine/project default > hardcoded default.
 *
 * Interaction/plan mode stays out of this resolver on purpose.
 */
export function resolveNewThreadRuntimeMode(sources: {
  readonly draftRuntimeMode?: RuntimeMode | null;
  readonly carryRuntimeMode?: RuntimeMode | null;
  readonly stickyRuntimeMode?: RuntimeMode | null;
  readonly configuredRuntimeMode?: RuntimeMode | null;
}): RuntimeMode {
  return (
    sources.draftRuntimeMode ??
    sources.carryRuntimeMode ??
    sources.stickyRuntimeMode ??
    sources.configuredRuntimeMode ??
    DEFAULT_RUNTIME_MODE
  );
}
