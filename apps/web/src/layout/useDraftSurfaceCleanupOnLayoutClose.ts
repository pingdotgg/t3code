import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useEffect } from "react";

import { hideThreadSurfaceTabs } from "../components/ThreadSurfaceTab";
import { useComposerDraftStore } from "../composerDraftStore";
import { readThreadShell } from "../state/entities";
import { subscribeLayoutThreadsClosedByUser } from "./layoutStore";

/** Closing an unsent draft hides its companion surfaces without settling any thread. */
export function useDraftSurfaceCleanupOnLayoutClose(): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to user-closed draft tabs and hides their companion surfaces until this owner unmounts
  useEffect(
    () =>
      subscribeLayoutThreadsClosedByUser((targets) => {
        for (const target of targets) {
          if (target.kind === "draft") {
            // A draft is not a thread yet, so what was opened beside it leaves with
            // its tab. It keeps running and comes back when the draft is reopened.
            const draft = useComposerDraftStore.getState().getDraftSession(target.draftId);
            if (!draft || draft.promotedTo) continue;
            const ref = scopeThreadRef(draft.environmentId, draft.threadId);
            if (readThreadShell(ref) === null) hideThreadSurfaceTabs(ref);
          }
        }
      }),
    [],
  );
}
