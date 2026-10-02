import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect } from "react";

import { useThreadShells } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useUiStateStore } from "../uiStateStore";

// Module-level so each thread is considered once per page load. The visit
// command is idempotent server-side (the server keeps max(stored, supplied)),
// so repeats across page loads are harmless — this only avoids re-dispatching
// within a session.
const migratedThreadKeys = new Set<string>();

/**
 * One-way migration of the browser-local visited watermarks into servers with
 * visited tracking. Before tracking existed, "Done" lived in this browser's
 * localStorage; pushing those watermarks up seeds the server value so other
 * devices see the same read state. The server never rewinds a newer visit, so
 * this cannot clobber progress made elsewhere.
 */
export function useThreadVisitedMigration(): void {
  const threads = useThreadShells();
  const visitThreadMutation = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  useEffect(() => {
    for (const thread of threads) {
      // Field absent → the environment's server has no visited tracking; keep
      // the local value in play and reconsider if the server upgrades.
      if (thread.lastVisitedAt === undefined) continue;
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      if (migratedThreadKeys.has(threadKey)) continue;
      migratedThreadKeys.add(threadKey);
      const local = useUiStateStore.getState().threadLastVisitedAtById[threadKey];
      if (!local) continue;
      const localMs = Date.parse(local);
      if (!Number.isFinite(localMs)) continue;
      const serverMs = thread.lastVisitedAt === null ? null : Date.parse(thread.lastVisitedAt);
      if (serverMs !== null && Number.isFinite(serverMs) && serverMs >= localMs) continue;
      void visitThreadMutation({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, visitedAt: local },
      });
    }
  }, [threads, visitThreadMutation]);
}
