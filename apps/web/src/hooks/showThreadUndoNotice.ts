import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { create } from "zustand";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import * as ThreadUndo from "./threadUndo";

type UndoOptions = {
  action: "Settled" | "Snoozed" | "Unpinned" | "Archived";
  undo: () => Promise<AtomCommandResult<unknown, unknown>>;
  failureTitle: string;
  claim: ReturnType<typeof ThreadUndo.begin>;
};

type UndoNotice = {
  action: UndoOptions["action"];
  count: number;
  undo: () => Promise<void>;
};

export const useThreadUndoNotice = create<{ notice: UndoNotice | null }>(() => ({ notice: null }));

// Shared across sidebar, header and menu actions. Consecutive actions of the
// same kind share one notice and can be restored together.
let liveUndos: UndoOptions[] = [];
let expiry: ReturnType<typeof setTimeout> | undefined;

function refreshNotice() {
  liveUndos = liveUndos.filter(({ claim }) => claim.isCurrent());
  const latest = liveUndos.at(-1);
  if (!latest) {
    clearTimeout(expiry);
    useThreadUndoNotice.setState({ notice: null });
    return;
  }
  const group: UndoOptions[] = [];
  for (let index = liveUndos.length - 1; index >= 0; index--) {
    const entry = liveUndos[index]!;
    if (entry.action !== latest.action) break;
    group.push(entry);
  }
  useThreadUndoNotice.setState({
    notice: {
      action: latest.action,
      count: group.length,
      undo: async () => {
        const current = group.filter(
          (entry) => liveUndos.includes(entry) && entry.claim.isCurrent(),
        );
        liveUndos = liveUndos.filter((entry) => !group.includes(entry));
        // Consume every claim before awaiting, so repeated clicks or shortcuts
        // cannot restore the same group twice.
        for (const entry of current) entry.claim.finish();
        refreshNotice();
        await Promise.all(
          current.map(async ({ undo, failureTitle }) => {
            const reportFailure = (error: unknown) => {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: failureTitle,
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            };
            try {
              const result = await undo();
              if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                reportFailure(squashAtomCommandFailure(result));
              }
            } catch (error) {
              reportFailure(error);
            }
          }),
        );
      },
    },
  });
}

ThreadUndo.subscribe(refreshNotice);

/** Runs the group displayed in the sidebar; false when nothing is left to undo. */
export function undoLatestThreadAction(): boolean {
  const notice = useThreadUndoNotice.getState().notice;
  if (!notice) return false;
  void notice.undo();
  return true;
}

/** Shows one compact confirmation for the currently undoable thread actions. */
export function showThreadUndoNotice(options: UndoOptions) {
  if (!options.claim.isCurrent()) return;
  liveUndos.push(options);
  refreshNotice();
  clearTimeout(expiry);
  expiry = setTimeout(() => {
    const expired = liveUndos;
    liveUndos = [];
    for (const { claim } of expired) claim.finish();
    refreshNotice();
  }, 5_000);
}
