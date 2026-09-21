import { useEffect, useRef } from "react";

import { reconcileAuthoritativeThreadRefs } from "./authoritativeThreadLifecycle";
import { releaseComposerDraftUploads } from "./lib/composerDraftUploads";
import { useLiveEnvironmentIds, useThreadRefs } from "./state/entities";
import { useEnvironments } from "./state/environments";

export function ComposerDraftArchiveObserver() {
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
      releaseComposerDraftUploads(threadRef);
    }
  }, [activeThreadRefs, catalogEnvironmentIds, environmentCatalogReady, liveEnvironmentIds]);

  return null;
}
