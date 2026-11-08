import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { AtomRegistry } from "effect/reactivity";

import { liveShellEnvironmentIdsAtom } from "../state/shell";
import { environmentThreadShells, threadEnvironment } from "../state/threads";
import { useUiStateStore } from "../uiStateStore";

/**
 * Hands visit times recorded locally (before servers tracked visits) to each
 * server once its threads are live, and again after each resync until the
 * server has one. Subscribed outside render, so a shell update re-renders
 * nothing.
 */
export function startThreadVisitedMigration(registry: AtomRegistry.AtomRegistry): () => void {
  const migratedThreadKeys = new Set<string>();
  const migrate = () => {
    const liveEnvironmentIds = registry.get(liveShellEnvironmentIdsAtom);
    for (const thread of registry.get(environmentThreadShells.threadShellsAtom)) {
      // An established server watermark may be deliberately older after Mark unread.
      if (thread.lastVisitedAt !== null) continue;
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      // Cached or resyncing shells may carry a stale null watermark; wait until they are live.
      if (!liveEnvironmentIds.has(thread.environmentId)) {
        migratedThreadKeys.delete(threadKey);
        continue;
      }
      if (migratedThreadKeys.has(threadKey)) continue;
      migratedThreadKeys.add(threadKey);
      const local = useUiStateStore.getState().threadLastVisitedAtById[threadKey];
      if (!local) continue;
      const localMs = Date.parse(local);
      if (!Number.isFinite(localMs)) continue;
      void runAtomCommand(
        registry,
        threadEnvironment.visit,
        { environmentId: thread.environmentId, input: { threadId: thread.id, visitedAt: local } },
        { reportFailure: false },
      );
    }
  };
  const stopShells = registry.subscribe(environmentThreadShells.threadShellsAtom, migrate, {
    immediate: true,
  });
  const stopLive = registry.subscribe(liveShellEnvironmentIdsAtom, migrate);
  return () => {
    stopShells();
    stopLive();
  };
}
