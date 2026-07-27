import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

interface CollectRemovedPreviewThreadRefsInput {
  readonly previousActiveThreadRefs: readonly ScopedThreadRef[];
  readonly activeThreadRefs: readonly ScopedThreadRef[];
}

export function collectRemovedPreviewThreadRefs(
  input: CollectRemovedPreviewThreadRefsInput,
): ScopedThreadRef[] {
  const activeThreadKeys = new Set(input.activeThreadRefs.map(scopedThreadKey));
  return input.previousActiveThreadRefs.filter(
    (threadRef) => !activeThreadKeys.has(scopedThreadKey(threadRef)),
  );
}
