import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { resolveThreadStatusPill, type ThreadStatusPill } from "../Sidebar.logic";
import { resolveSnoozePresets, type SnoozePreset } from "../Sidebar.snooze";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useClientSettings } from "../../hooks/useSettings";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";

export interface BoardCardActions {
  readonly openThread: (threadRef: ScopedThreadRef) => void;
  readonly pinThread: (threadRef: ScopedThreadRef) => void;
  readonly unpinThread: (threadRef: ScopedThreadRef) => void;
  readonly settleThread: (threadRef: ScopedThreadRef) => void;
  readonly unsettleThread: (threadRef: ScopedThreadRef) => void;
  readonly snoozeThread: (threadRef: ScopedThreadRef, snoozedUntil: string) => void;
  readonly unsnoozeThread: (threadRef: ScopedThreadRef) => void;
  readonly archiveThread: (threadRef: ScopedThreadRef) => void;
  readonly deleteThread: (threadRef: ScopedThreadRef) => void;
  readonly resolveStatusPill: (thread: SidebarThreadSummary) => ThreadStatusPill | null;
  readonly resolveSnoozePresets: () => ReadonlyArray<SnoozePreset>;
}

/**
 * Every board mutation is an existing thread command. Failures surface as a
 * toast rather than a rolled-back card, because the board renders straight
 * off the shell stream: the server's next event is what moves the card, so
 * there is no optimistic state to undo.
 */
export function useBoardCardActions(): BoardCardActions {
  const router = useRouter();
  const {
    archiveThread,
    confirmAndDeleteThread,
    pinThread,
    settleThread,
    snoozeThread,
    unpinThread,
    unsettleThread,
    unsnoozeThread,
  } = useThreadActions();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);

  const report = useCallback((title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag !== "Failure") return;
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }, []);

  const openThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [router],
  );

  const resolveStatusPill = useCallback(
    (thread: SidebarThreadSummary) =>
      resolveThreadStatusPill({
        thread: {
          ...thread,
          lastVisitedAt:
            threadLastVisitedAtById[
              scopedThreadKey({
                environmentId: thread.environmentId,
                threadId: thread.id,
              })
            ],
        },
      }),
    [threadLastVisitedAtById],
  );

  return useMemo(
    () => ({
      openThread,
      resolveStatusPill,
      // Presets resolve at open time so "In 1 hour" is relative to the click,
      // not to when the card mounted.
      resolveSnoozePresets: () => resolveSnoozePresets(new Date(), timestampFormat),
      pinThread: (threadRef) => {
        void pinThread(threadRef).then((result) => report("Failed to pin thread", result));
      },
      unpinThread: (threadRef) => {
        void unpinThread(threadRef).then((result) => report("Failed to unpin thread", result));
      },
      // Settle is a high-frequency lifecycle action and stays silent on
      // success, matching the sidebar.
      settleThread: (threadRef) => {
        void settleThread(threadRef).then((result) => report("Failed to settle thread", result));
      },
      unsettleThread: (threadRef) => {
        void unsettleThread(threadRef).then((result) =>
          report("Failed to un-settle thread", result),
        );
      },
      snoozeThread: (threadRef, snoozedUntil) => {
        void snoozeThread(threadRef, snoozedUntil).then((result) =>
          report("Failed to snooze thread", result),
        );
      },
      unsnoozeThread: (threadRef) => {
        void unsnoozeThread(threadRef).then((result) => report("Failed to wake thread", result));
      },
      archiveThread: (threadRef) => {
        void archiveThread(threadRef).then((result) => report("Failed to archive thread", result));
      },
      deleteThread: (threadRef) => {
        void confirmAndDeleteThread(threadRef).then((result) =>
          report("Failed to delete thread", result),
        );
      },
    }),
    [
      archiveThread,
      confirmAndDeleteThread,
      openThread,
      pinThread,
      report,
      resolveStatusPill,
      settleThread,
      snoozeThread,
      timestampFormat,
      unpinThread,
      unsettleThread,
      unsnoozeThread,
    ],
  );
}
