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
import { useCallback, useEffect, useRef, useState } from "react";

import type { SourceControlConfirmOptions } from "~/lib/sourceControl/safetyLadder";

/**
 * fork: f4 F-13 — a free-text rung.
 *
 * "Create tag here…" used `window.prompt`, which an Electron renderer does not
 * implement (it returns `undefined` and logs "prompt() is and will not be
 * supported"), so the menu item did nothing at all in the desktop app. The
 * dialog already renders a typed-confirmation input; this is that input with a
 * value the caller keeps.
 */
export interface SourceControlPromptOptions {
  readonly title: string;
  /** Plain English: what the value is for. Required, same as a confirm rung. */
  readonly consequence: string;
  readonly inputLabel: string;
  readonly confirmLabel: string;
  readonly placeholder?: string | undefined;
  readonly initialValue?: string | undefined;
}

export interface PendingSourceControlConfirm {
  readonly id: number;
  readonly kind: "confirm";
  readonly options: SourceControlConfirmOptions;
}

export interface PendingSourceControlPrompt {
  readonly id: number;
  readonly kind: "prompt";
  readonly options: SourceControlPromptOptions;
}

export type PendingSourceControlRequest = PendingSourceControlConfirm | PendingSourceControlPrompt;

export interface SourceControlConfirmController {
  readonly pending: PendingSourceControlRequest | null;
  /** Resolves true to proceed, false to cancel, "alternative" for the safer path. */
  readonly confirm: (options: SourceControlConfirmOptions) => Promise<ConfirmOutcome>;
  /** Resolves the typed value, or `null` when cancelled. */
  readonly promptText: (options: SourceControlPromptOptions) => Promise<string | null>;
  readonly resolve: (outcome: ConfirmOutcome, value?: string) => void;
}

export type ConfirmOutcome = "confirmed" | "cancelled" | "alternative";

type Resolver = (outcome: ConfirmOutcome, value?: string) => void;

export function useSourceControlConfirm(): SourceControlConfirmController {
  const [pending, setPending] = useState<PendingSourceControlRequest | null>(null);
  const resolverRef = useRef<Resolver | null>(null);
  const idRef = useRef(0);

  /**
   * fork: f4 F-18 — a promise only this component can settle must be settled
   * when this component goes away. The panel has two early returns above the
   * dialog and is `lazy` + unmounted whenever the right-panel surface changes,
   * so an awaiting `discard` used to hang forever with its busy key held.
   */
  useEffect(
    () => () => {
      const resolver = resolverRef.current;
      resolverRef.current = null;
      resolver?.("cancelled");
    },
    [],
  );

  const confirm = useCallback((options: SourceControlConfirmOptions) => {
    // A second request while one is open cancels the first rather than stacking
    // dialogs — two modals over one list is how people confirm the wrong thing.
    resolverRef.current?.("cancelled");
    idRef.current += 1;
    setPending({ id: idRef.current, kind: "confirm", options });
    return new Promise<ConfirmOutcome>((resolvePromise) => {
      resolverRef.current = (outcome) => resolvePromise(outcome);
    });
  }, []);

  const promptText = useCallback((options: SourceControlPromptOptions) => {
    resolverRef.current?.("cancelled");
    idRef.current += 1;
    setPending({ id: idRef.current, kind: "prompt", options });
    return new Promise<string | null>((resolvePromise) => {
      resolverRef.current = (outcome, value) => {
        resolvePromise(outcome === "confirmed" ? (value ?? "") : null);
      };
    });
  }, []);

  const resolve = useCallback((outcome: ConfirmOutcome, value?: string) => {
    const resolver = resolverRef.current;
    resolverRef.current = null;
    setPending(null);
    resolver?.(outcome, value);
  }, []);

  return { pending, confirm, promptText, resolve };
}
