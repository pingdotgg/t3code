import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadHasNoPendingWake } from "@t3tools/client-runtime/state/thread-inbox";
import { Atom } from "effect/reactivity";

import { serverEnvironment } from "../../state/server";

const UNKNOWN_SCHEDULED_WAKE_ATOM = Atom.make<boolean | null>(null);

/** Only threads that are otherwise idle subscribe to the scheduled task list. */
export function useThreadHasNoPendingWake(
  thread: EnvironmentThreadShell,
  enabled: boolean,
): boolean {
  const mayBeIdle = enabled && threadHasNoPendingWake(thread, false);
  const hasScheduledWake = useAtomValue(
    mayBeIdle
      ? serverEnvironment.threadHasScheduledWake(
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        )
      : UNKNOWN_SCHEDULED_WAKE_ATOM,
  );
  return mayBeIdle && hasScheduledWake === false;
}
