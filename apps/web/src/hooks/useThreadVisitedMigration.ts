import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect } from "react";

import { useThreadShells } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useUiStateStore } from "../uiStateStore";

const migratedThreadKeys = new Set<string>();

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
