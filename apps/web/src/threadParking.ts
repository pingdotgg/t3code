import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRef, useState } from "react";

interface ThreadParkingContext {
  readonly activeThreadKey: string | null;
  readonly orderedThreadKeys: readonly string[];
  readonly isParked: (key: string) => boolean;
  /** Capture the target now, before the command changes the visible thread list. */
  readonly planNext: (key: string) => (() => void) | null;
  readonly planFallback: (key: string) => () => void;
}

export type ThreadParkingOutcome =
  | { readonly status: "success" | "interrupted" | "skipped" }
  | { readonly status: "failure"; readonly error: unknown };

/** One pending-action scope. Callers choose whether settle and snooze share it. */
export function createThreadParking(readContext: () => ThreadParkingContext) {
  const pending = new Set<string>();

  function planNavigation(threadKey: string, coParkingKeys?: ReadonlySet<string>) {
    const context = readContext();
    if (context.activeThreadKey !== threadKey) return null;
    const keys = context.orderedThreadKeys;
    const index = keys.indexOf(threadKey);
    const nextKey =
      index === -1
        ? undefined
        : [...keys.slice(index + 1), ...keys.slice(0, index)].find(
            (key) => !context.isParked(key) && !coParkingKeys?.has(key),
          );
    return (
      (nextKey === undefined ? null : context.planNext(nextKey)) ?? context.planFallback(threadKey)
    );
  }

  return {
    isPending: (key: string) => pending.has(key),
    async run(
      threadKey: string,
      command: () => Promise<AtomCommandResult<unknown, unknown>>,
      coParkingKeys?: ReadonlySet<string>,
    ): Promise<ThreadParkingOutcome> {
      if (pending.has(threadKey)) return { status: "skipped" };
      pending.add(threadKey);
      try {
        const navigateAfter = planNavigation(threadKey, coParkingKeys);
        const result = await command();
        if (result._tag === "Failure") {
          return isAtomCommandInterrupted(result)
            ? { status: "interrupted" }
            : { status: "failure", error: squashAtomCommandFailure(result) };
        }
        // A navigation made while the command was pending wins over this plan.
        if (readContext().activeThreadKey === threadKey) navigateAfter?.();
        return { status: "success" };
      } finally {
        pending.delete(threadKey);
      }
    },
  };
}

/** Keep pending actions across renders while commands read the latest caller state. */
export function useThreadParking(readContext: () => ThreadParkingContext) {
  const contextRef = useRef(readContext);
  contextRef.current = readContext;
  const [parking] = useState(() => createThreadParking(() => contextRef.current()));
  return parking;
}
