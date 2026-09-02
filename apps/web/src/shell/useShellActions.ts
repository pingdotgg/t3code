import { ShellAction } from "@t3tools/contracts/shell";
import * as Schema from "effect/Schema";
import { useEffect, useRef } from "react";

const isShellAction = Schema.is(ShellAction);

/** Reassembles an action from the wire (`type` travels beside its payload) and validates it. */
export function decodeShellAction(type: string, payload: unknown): ShellAction | null {
  const candidate = {
    ...(typeof payload === "object" && payload !== null ? payload : {}),
    type,
  };
  return isShellAction(candidate) ? candidate : null;
}

/**
 * Runs `handler` for every valid action the shell dispatches, for the
 * component's lifetime. One subscription per mount: the handler is read
 * through a ref, so it may close over the latest props and hooks without
 * resubscribing (each subscription round-trips the channel).
 */
export function useShellActions(handler: (action: ShellAction) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const shell = window.t3Shell;
    if (!shell) return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void shell
      .onAction((type, payload) => {
        const action = decodeShellAction(type, payload);
        if (action !== null) handlerRef.current(action);
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unsubscribe = dispose;
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);
}
