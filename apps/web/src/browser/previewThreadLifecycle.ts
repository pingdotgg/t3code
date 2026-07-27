import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

interface CollectRemovedPreviewThreadRefsInput {
  readonly previousActiveThreadRefs: readonly ScopedThreadRef[];
  readonly activeThreadRefs: readonly ScopedThreadRef[];
  readonly previewThreadKeys: Iterable<string>;
  readonly miniPlayerThreadKeys: Iterable<string>;
}

export function collectRemovedPreviewThreadRefs(
  input: CollectRemovedPreviewThreadRefsInput,
): ScopedThreadRef[] {
  const activeThreadKeys = new Set(input.activeThreadRefs.map(scopedThreadKey));
  const previewThreadKeys = new Set([...input.previewThreadKeys, ...input.miniPlayerThreadKeys]);

  return input.previousActiveThreadRefs.filter((threadRef) => {
    const threadKey = scopedThreadKey(threadRef);
    return !activeThreadKeys.has(threadKey) && previewThreadKeys.has(threadKey);
  });
}
