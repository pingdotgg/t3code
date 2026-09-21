import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type * as ThreadUndo from "./threadUndo";

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
  const reportFailure = (error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: failureTitle,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };
  const toastId = toastManager.add({
    ...stackedThreadToast({
      type: "success",
      title,
      description,
      timeout: 5_000,
      actionProps: {
        children: "Undo",
        onClick: async () => {
          if (undoStarted || !claim.isCurrent()) return;
          undoStarted = true;
          claim.finish();
          toastManager.close(toastId);
          try {
            const result = await undo();
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              reportFailure(squashAtomCommandFailure(result));
            }
          } catch (error) {
            reportFailure(error);
          }
        },
      },
    }),
    onClose: claim.finish,
  });
}
