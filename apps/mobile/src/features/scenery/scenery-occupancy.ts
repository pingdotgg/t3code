import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { isThreadSettled } from "../../lib/threadInbox";

/** Minimal shape of a queued pending task holding a reserved scene. */
export interface PendingSceneReservation {
  readonly message: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  };
}

/**
 * Thread keys whose scene counts as "in use" when picking the next thread's
 * scene: every open (unarchived), unsettled thread, plus queued pending tasks
 * whose reserved scene was committed at enqueue time. Settled and archived
 * threads release their location for reuse. Mirrors
 * `AppModel.activeSceneThreadKeys` on mac.
 */
export function occupiedSceneryThreadKeys(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks?: ReadonlyArray<PendingSceneReservation>;
  readonly now?: string;
}): Set<string> {
  const keys = new Set<string>();
  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    if (isThreadSettled(thread, input.now)) continue;
    keys.add(scopedThreadKey(thread.environmentId, thread.id));
  }
  for (const task of input.pendingTasks ?? []) {
    keys.add(scopedThreadKey(task.message.environmentId, task.message.threadId));
  }
  return keys;
}
