import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { AtomRegistry } from "effect/reactivity";

import { environmentThreadShells, threadEnvironment } from "../state/threads";
import { useUiStateStore } from "../uiStateStore";

/**
 * Hands visit times recorded locally (before servers tracked visits) to each
 * server once. Subscribed outside render: it only acts on threads it has not
 * seen, so a shell update must not re-render anything.
 */
export function startThreadVisitedMigration(registry: AtomRegistry.AtomRegistry): () => void {
  const migratedThreadKeys = new Set<string>();
  const migrate = (threads: ReadonlyArray<EnvironmentThreadShell>) => {
    for (const thread of threads) {
      // Missing means unsupported; retain the local value until the server upgrades.
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
      void runAtomCommand(
        registry,
        threadEnvironment.visit,
        { environmentId: thread.environmentId, input: { threadId: thread.id, visitedAt: local } },
        { reportFailure: false },
      );
    }
  };
  return registry.subscribe(environmentThreadShells.threadShellsAtom, migrate, {
    immediate: true,
  });
}
