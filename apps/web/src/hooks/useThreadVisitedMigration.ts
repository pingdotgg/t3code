import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useContext, useEffect, useEffectEvent } from "react";

import { environmentThreadShells, threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useUiStateStore } from "../uiStateStore";

const migratedThreadKeys = new Set<string>();

// Subscribe outside render; shell updates must not re-render the layout for this one-time migration.
export function useThreadVisitedMigration(): void {
  const registry = useContext(RegistryContext);
  const visitThreadMutation = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const migrate = useEffectEvent((threads: ReadonlyArray<EnvironmentThreadShell>) => {
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
      void visitThreadMutation({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, visitedAt: local },
      });
    }
  });
  useEffect(
    () =>
      registry.subscribe(environmentThreadShells.threadShellsAtom, migrate, { immediate: true }),
    [registry],
  );
}
