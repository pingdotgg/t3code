import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId } from "@t3tools/contracts";

import type { SidebarThreadStatusFilter } from "../uiStateStore";

export type LegacySidebarFilterableThread = ThreadSnoozeShell & {
  readonly archivedAt: string | null;
  readonly environmentId: EnvironmentId;
  readonly settledOverride: "active" | "settled" | null;
};

export function legacySidebarThreadMatchesFilters(
  thread: LegacySidebarFilterableThread,
  input: {
    readonly environmentId: string | null;
    readonly status: SidebarThreadStatusFilter;
    readonly now: string;
  },
): boolean {
  if (thread.archivedAt !== null) return false;
  if (input.environmentId !== null && thread.environmentId !== input.environmentId) return false;
  if (input.status === "all") return true;

  const status = effectiveSnoozed(thread, { now: input.now })
    ? "snoozed"
    : thread.settledOverride === "settled"
      ? "settled"
      : "active";
  return status === input.status;
}
