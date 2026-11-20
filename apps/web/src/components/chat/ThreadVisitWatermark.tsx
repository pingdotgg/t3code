import { useAtomMount } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { createThreadVisitTracker } from "@t3tools/client-runtime/state/thread-visits";
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { type ScopedThreadRef, WS_METHODS } from "@t3tools/contracts";
import { useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { subscribeDocumentReturn } from "../../lib/documentActivity";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useUiStateStore } from "../../uiStateStore";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";

const threadVisitTracker = createThreadVisitTracker({
  threadShellAtom: environmentThreadShells.threadShellAtom,
  sessionGenerationAtom: environmentCatalog.sessionGenerationAtom,
  visit: threadEnvironment.visit,
  markLocalVisit: (ref, visitedAt) =>
    useUiStateStore.getState().markThreadVisited(scopedThreadKey(ref), visitedAt),
});

const refreshCodexHistory = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:refresh-codex-history",
  tag: WS_METHODS.agentSessionsRefreshCodexHistory,
});

// The visit watermark is the one part of the chat view that follows the
// shell's updatedAt, which ticks while a run streams. The tracker subscribes to
// it outside React, so ChatView keeps reading the quiet shell.
export function ThreadVisitWatermark({
  threadRef,
  canRefreshCodexHistory,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly canRefreshCodexHistory?: boolean;
}) {
  useAtomMount(threadVisitTracker(threadRef));
  const { environmentId, threadId } = threadRef;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refresh the viewed native chat when the user returns to this window
  useEffect(() => {
    if (!canRefreshCodexHistory) return;
    const refresh = () => {
      if (document.visibilityState === "visible") {
        void runAtomCommand(
          appAtomRegistry,
          refreshCodexHistory,
          { environmentId, input: { threadId } },
          { reportFailure: false },
        );
      }
    };
    refresh();
    return subscribeDocumentReturn(refresh);
  }, [canRefreshCodexHistory, environmentId, threadId]);
  return null;
}
