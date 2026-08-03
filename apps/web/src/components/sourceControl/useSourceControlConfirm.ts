/**
 * Promise-shaped access to the safety ladder's confirm rungs.
 *
 * The ladder descriptors are pure (`safetyLadder.ts`); this turns one into a
 * dialog and back into a boolean so an action reads as a straight line rather
 * than as a callback tree. Actions that are undoable must never come through
 * here — they raise an undo toast instead.
 *
 * fork: f4 source-control panel
 */
import { useCallback, useRef, useState } from "react";

import type { SourceControlConfirmOptions } from "~/lib/sourceControl/safetyLadder";

export interface PendingSourceControlConfirm {
  readonly id: number;
  readonly options: SourceControlConfirmOptions;
}

export interface SourceControlConfirmController {
  readonly pending: PendingSourceControlConfirm | null;
  /** Resolves true to proceed, false to cancel, "alternative" for the safer path. */
  readonly confirm: (options: SourceControlConfirmOptions) => Promise<ConfirmOutcome>;
  readonly resolve: (outcome: ConfirmOutcome) => void;
}

export type ConfirmOutcome = "confirmed" | "cancelled" | "alternative";

export function useSourceControlConfirm(): SourceControlConfirmController {
  const [pending, setPending] = useState<PendingSourceControlConfirm | null>(null);
  const resolverRef = useRef<((outcome: ConfirmOutcome) => void) | null>(null);
  const idRef = useRef(0);

  const confirm = useCallback((options: SourceControlConfirmOptions) => {
    // A second request while one is open cancels the first rather than stacking
    // dialogs — two modals over one list is how people confirm the wrong thing.
    resolverRef.current?.("cancelled");
    idRef.current += 1;
    setPending({ id: idRef.current, options });
    return new Promise<ConfirmOutcome>((resolvePromise) => {
      resolverRef.current = resolvePromise;
    });
  }, []);

  const resolve = useCallback((outcome: ConfirmOutcome) => {
    const resolver = resolverRef.current;
    resolverRef.current = null;
    setPending(null);
    resolver?.(outcome);
  }, []);

  return { pending, confirm, resolve };
}
