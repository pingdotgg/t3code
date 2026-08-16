import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useCallback, useRef, useState } from "react";

import type { useThreadActions } from "./useThreadActions";
import { readThreadShell } from "../state/entities";
import {
  canArchiveSettledSidebarThread,
  isThreadArchiveBlocked,
} from "../components/SidebarArchiveControls.logic";
import {
  useThreadArchiveActions,
  type ThreadArchiveEntry,
} from "./useThreadArchiveActions";

export type SidebarArchiveEntry = ThreadArchiveEntry;

type SidebarArchiveActionsInput = {
  readonly archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  readonly archivableSettledThreads: readonly EnvironmentThreadShell[];
  readonly confirmThreadArchive: boolean;
  readonly settledThreadKeysRef: { readonly current: ReadonlySet<string> };
};

/**
 * Adds the default sidebar's bulk and settled-membership policies to the
 * shared archive lifecycle. Keeping those policies out of the upstream-owned
 * sidebar component limits future reconciliations to its integration points.
 */
export function useSidebarArchiveActions({
  archiveThread,
  archivableSettledThreads,
  confirmThreadArchive,
  settledThreadKeysRef,
}: SidebarArchiveActionsInput) {
  const { archiveCoordinatedEntries, attemptArchive } = useThreadArchiveActions({
    archiveThread,
    confirmThreadArchive,
  });

  const archiveSelectedEntries = useCallback(
    (entries: readonly SidebarArchiveEntry[]) =>
      archiveCoordinatedEntries(entries, {
        confirmationMessage: (ownedEntries) => {
          const count = ownedEntries.length;
          return `Archive ${count} thread${count === 1 ? "" : "s"}?`;
        },
        canArchive: ({ threadRef }) => !isThreadArchiveBlocked(readThreadShell(threadRef)),
      }),
    [archiveCoordinatedEntries],
  );

  const [isArchivingAllSettled, setIsArchivingAllSettled] = useState(false);
  const archivingAllSettledRef = useRef(false);
  const archiveAllSettled = useCallback(() => {
    void (async () => {
      if (archivingAllSettledRef.current || archivableSettledThreads.length === 0) return;
      archivingAllSettledRef.current = true;
      setIsArchivingAllSettled(true);
      try {
        await archiveCoordinatedEntries(
          archivableSettledThreads.map((thread) => {
            const threadRef = scopeThreadRef(thread.environmentId, thread.id);
            return { threadKey: scopedThreadKey(threadRef), threadRef };
          }),
          {
            confirmationMessage: (ownedEntries) => {
              const count = ownedEntries.length;
              return `Archive all ${count} settled thread${count === 1 ? "" : "s"}?`;
            },
            canArchive: ({ threadKey, threadRef }) => {
              const thread = readThreadShell(threadRef);
              return canArchiveSettledSidebarThread({
                threadKey,
                settledThreadKeys: settledThreadKeysRef.current,
                session: thread?.session,
                backgroundLiveness: thread?.backgroundLiveness,
              });
            },
          },
        );
      } finally {
        archivingAllSettledRef.current = false;
        setIsArchivingAllSettled(false);
      }
    })();
  }, [archivableSettledThreads, archiveCoordinatedEntries]);

  return {
    archiveAllSettled,
    archiveSelectedEntries,
    attemptArchive,
    isArchivingAllSettled,
  };
}
