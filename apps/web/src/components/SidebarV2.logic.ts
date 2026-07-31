import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";

import type { SidebarThreadSummary } from "../types";

export type ThreadLifecycleSupport = {
  readonly settlement: boolean;
  readonly snooze: boolean;
};

/**
 * Lifecycle capabilities are resolved per environment rather than reduced to a
 * single flag for the whole sidebar: an environment whose server predates
 * thread.settle/snooze must degrade only its own rows, not disable the inbox
 * for every other environment's threads.
 */
export function resolveThreadLifecycleSupport(
  descriptors: readonly (ExecutionEnvironmentDescriptor | null | undefined)[],
): ReadonlyMap<string, ThreadLifecycleSupport> {
  const byEnvironment = new Map<string, ThreadLifecycleSupport>();
  for (const descriptor of descriptors) {
    if (!descriptor) continue;
    byEnvironment.set(descriptor.environmentId, {
      settlement: descriptor.capabilities.threadSettlement === true,
      snooze: descriptor.capabilities.threadSnooze === true,
    });
  }
  return byEnvironment;
}

/**
 * Bulk shelf actions fan out to one command per thread, so they must offer only
 * threads that can actually accept it. An unsupported environment or
 * blocked-on-you work is rejected server-side, which would half-apply the
 * action and report a failure the user cannot act on.
 */
export function selectSnoozeShelfBulkTargets({
  snoozed,
  lifecycleSupport,
  now,
}: {
  readonly snoozed: readonly SidebarThreadSummary[];
  readonly lifecycleSupport: ReadonlyMap<string, ThreadLifecycleSupport>;
  readonly now: string;
}): {
  readonly wakeable: readonly SidebarThreadSummary[];
  readonly reschedulable: readonly SidebarThreadSummary[];
} {
  const wakeable = snoozed.filter(
    (thread) => lifecycleSupport.get(thread.environmentId)?.snooze === true,
  );
  return {
    wakeable,
    reschedulable: wakeable.filter((thread) => canSnooze(thread, { now })),
  };
}
