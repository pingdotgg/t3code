import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type * as ThreadUndo from "./threadUndo";

// Undo toasts still on screen, oldest first, so the `thread.undo` shortcut
// mirrors the newest toast's button without knowing which action it was.
const liveUndos: Array<() => Promise<void> | null> = [];

/** Runs the newest Undo whose claim still holds; false when nothing is left to undo. */
export function undoLatestThreadAction(): boolean {
  // A superseded entry drops itself when tried, so keep going until one
  // runs or the list is empty.
  while (liveUndos.length > 0) {
    if (liveUndos[liveUndos.length - 1]?.() !== null) return true;
  }
  return false;
}

/** Shows a single-use Undo while its thread action still owns the claim. */
export function showUndoToast({
  title,
  description,
  undo,
  failureTitle,
  claim,
}: {
  title: string;
  description: string | undefined;
  undo: () => Promise<AtomCommandResult<unknown, unknown>>;
  failureTitle: string;
  claim: ReturnType<typeof ThreadUndo.begin>;
}) {
  if (!claim.isCurrent()) return;
  let undoStarted = false;
  let toastId: string | undefined;
  const reportFailure = (error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: failureTitle,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };
  const forget = () => {
    const index = liveUndos.indexOf(run);
    if (index !== -1) liveUndos.splice(index, 1);
  };
  const run = () => {
    forget();
    if (undoStarted || !claim.isCurrent()) return null;
    undoStarted = true;
    claim.finish();
    if (toastId !== undefined) toastManager.close(toastId);
    return undo()
      .then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          reportFailure(squashAtomCommandFailure(result));
        }
      })
      .catch(reportFailure);
  };
  liveUndos.push(run);
  toastId = toastManager.add({
    ...stackedThreadToast({
      type: "success",
      title,
      description,
      timeout: 5_000,
      actionProps: {
        children: "Undo",
        onClick: async () => {
          await run();
        },
      },
    }),
    onClose: () => {
      claim.finish();
      forget();
    },
  });
}
