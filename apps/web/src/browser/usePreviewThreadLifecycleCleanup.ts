import { useEffect, useRef } from "react";

import { reconcileAuthoritativeThreadRefs } from "~/authoritativeThreadLifecycle";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { removePreviewThread } from "~/previewStateStore";
import { useLiveEnvironmentIds, useThreadRefs } from "~/state/entities";
import { useEnvironments } from "~/state/environments";

export function usePreviewThreadLifecycleCleanup(): void {
  const activeThreadRefs = useThreadRefs();
  const liveEnvironmentIds = useLiveEnvironmentIds();
  const { environmentIds: catalogEnvironmentIds, isReady: environmentCatalogReady } =
    useEnvironments();
  const previousActiveThreadRefs = useRef(activeThreadRefs);

  useEffect(() => {
    const reconciliation = reconcileAuthoritativeThreadRefs({
      previousActiveThreadRefs: previousActiveThreadRefs.current,
      activeThreadRefs,
      catalogEnvironmentIds: environmentCatalogReady ? catalogEnvironmentIds : null,
      liveEnvironmentIds,
    });
    previousActiveThreadRefs.current = reconciliation.nextActiveThreadRefs;
    for (const threadRef of reconciliation.removedThreadRefs) {
      removePreviewThread(threadRef);
      usePreviewMiniPlayerStore.getState().removeThread(threadRef);
    }
  }, [activeThreadRefs, catalogEnvironmentIds, environmentCatalogReady, liveEnvironmentIds]);
}
