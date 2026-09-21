import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

interface ReconcileAuthoritativeThreadRefsInput {
  readonly previousActiveThreadRefs: readonly ScopedThreadRef[];
  readonly activeThreadRefs: readonly ScopedThreadRef[];
  readonly catalogEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly liveEnvironmentIds: ReadonlySet<EnvironmentId>;
}

interface ReconcileAuthoritativeThreadRefsResult {
  readonly removedThreadRefs: readonly ScopedThreadRef[];
  readonly nextActiveThreadRefs: readonly ScopedThreadRef[];
}

/**
 * Retains each environment's prior thread baseline until its shell becomes
 * authoritative, then reports active threads that disappeared. Catalog
 * removal is authoritative once catalog hydration completes too.
 */
export function reconcileAuthoritativeThreadRefs(
  input: ReconcileAuthoritativeThreadRefsInput,
): ReconcileAuthoritativeThreadRefsResult {
  const activeThreadKeys = new Set(input.activeThreadRefs.map(scopedThreadKey));
  const baselineEnvironmentIds = new Set(
    input.previousActiveThreadRefs.map((threadRef) => threadRef.environmentId),
  );
  const removedThreadRefs = input.previousActiveThreadRefs.filter(
    (threadRef) =>
      (input.catalogEnvironmentIds !== null &&
        !input.catalogEnvironmentIds.has(threadRef.environmentId)) ||
      (input.liveEnvironmentIds.has(threadRef.environmentId) &&
        !activeThreadKeys.has(scopedThreadKey(threadRef))),
  );
  const nextActiveThreadRefs = [
    ...input.previousActiveThreadRefs.filter(
      (threadRef) =>
        (input.catalogEnvironmentIds === null ||
          input.catalogEnvironmentIds.has(threadRef.environmentId)) &&
        !input.liveEnvironmentIds.has(threadRef.environmentId),
    ),
    ...input.activeThreadRefs.filter(
      (threadRef) =>
        (input.catalogEnvironmentIds === null ||
          input.catalogEnvironmentIds.has(threadRef.environmentId)) &&
        (input.liveEnvironmentIds.has(threadRef.environmentId) ||
          !baselineEnvironmentIds.has(threadRef.environmentId)),
    ),
  ];
  return { removedThreadRefs, nextActiveThreadRefs };
}
