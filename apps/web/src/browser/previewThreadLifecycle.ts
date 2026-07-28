import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

interface ReconcilePreviewThreadRefsInput {
  readonly previousActiveThreadRefs: readonly ScopedThreadRef[];
  readonly activeThreadRefs: readonly ScopedThreadRef[];
  readonly catalogEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly liveEnvironmentIds: ReadonlySet<EnvironmentId>;
}

interface ReconcilePreviewThreadRefsResult {
  readonly removedThreadRefs: readonly ScopedThreadRef[];
  readonly nextActiveThreadRefs: readonly ScopedThreadRef[];
}

export function reconcilePreviewThreadRefs(
  input: ReconcilePreviewThreadRefsInput,
): ReconcilePreviewThreadRefsResult {
  const activeThreadKeys = new Set(input.activeThreadRefs.map(scopedThreadKey));
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
        input.liveEnvironmentIds.has(threadRef.environmentId),
    ),
  ];
  return { removedThreadRefs, nextActiveThreadRefs };
}
