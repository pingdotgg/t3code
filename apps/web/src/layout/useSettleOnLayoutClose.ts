/**
 * Open tabs stay active across automatic settlement unless explicitly settled here.
 * User-closing a chat tab sends thread.settle to every device; navigation and companion closes do not.
 * Reopening does not unsettle; sending a message does.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { useEffect } from "react";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { hideThreadSurfaceTabs } from "../components/ThreadSurfaceTab";
import { useComposerDraftStore } from "../composerDraftStore";
import { useThreadActions } from "../hooks/useThreadActions";
import { useStableCallback } from "../hooks/useStableCallback";
import { readEnvironmentServerConfigLoaded, readThreadShell } from "../state/entities";
import { subscribeLayoutThreadsClosedByUser } from "./layoutStore";

/** Only user closes settle eligible threads; working, queued, pinned and snoozed threads keep their
 * state. Unsent drafts also hide their surfaces. */
export function useSettleOnLayoutClose(): void {
  const { settleThread } = useThreadActions();
  const settle = useStableCallback(settleThread);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to user-closed layout tabs and settles eligible threads until this owner unmounts
  useEffect(
    () =>
      subscribeLayoutThreadsClosedByUser((targets) => {
        const now = new Date().toISOString();
        for (const target of targets) {
          if (target.kind === "draft") {
            // A draft is not a thread yet, so what was opened beside it leaves with
            // its tab. It keeps running and comes back when the draft is reopened.
            const draft = useComposerDraftStore.getState().getDraftSession(target.draftId);
            if (!draft || draft.promotedTo) continue;
            const ref = scopeThreadRef(draft.environmentId, draft.threadId);
            if (readThreadShell(ref) === null) hideThreadSurfaceTabs(ref);
            continue;
          }
          const ref = target.threadRef;
          if (!readEnvironmentServerConfigLoaded(ref.environmentId)) continue;
          const shell = readThreadShell(ref);
          if (!shell || shell.archivedAt != null) continue;
          if (shell.settledOverride === "settled" || shell.pinnedAt != null) continue;
          if (effectiveSnoozed(shell, { now })) continue;
          const status = resolveSidebarThreadStatus(shell);
          if (status === "working" || status === "approval" || status === "input") continue;
          void settle(ref);
        }
      }),
    [settle],
  );
}
