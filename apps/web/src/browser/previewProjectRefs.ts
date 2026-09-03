import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef } from "@t3tools/contracts";

// Project atoms forget a project after deletion, but its preview partition can
// still need to be cleared when a browser profile is removed later in this run.
const rememberedPreviewProjectRefs = new Map<string, ScopedProjectRef>();

export function rememberPreviewProjectRef(ref: ScopedProjectRef): void {
  rememberedPreviewProjectRefs.set(scopedProjectKey(ref), ref);
}

export function readRememberedPreviewProjectRefs(): ReadonlyArray<ScopedProjectRef> {
  return [...rememberedPreviewProjectRefs.values()];
}
