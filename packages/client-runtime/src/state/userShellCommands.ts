import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "@t3tools/contracts";

type CommandItem = Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }>;

/** A `command_execution` item the user ran with `!`, not the agent. */
export type UserShellItem = CommandItem & {
  readonly userShell: NonNullable<CommandItem["userShell"]>;
};

const SETTLED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

export function isUserShellItem(item: { readonly type: string }): item is UserShellItem {
  return item.type === "command_execution" && (item as CommandItem).userShell !== undefined;
}

/**
 * User-run shell results the server prepends to the next message. Items of a run that is
 * still going are left out, so a command the agent is about to answer never shows as pending.
 */
export function pendingUserShellItems(projection: {
  readonly turnItems: ReadonlyArray<{ readonly type: string }>;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">>;
}): ReadonlyArray<UserShellItem> {
  const activeRunIds = new Set(
    projection.runs.filter((run) => !SETTLED_RUN_STATUSES.has(run.status)).map((run) => run.id),
  );
  return projection.turnItems.filter(
    (item): item is UserShellItem =>
      isUserShellItem(item) &&
      item.userShell.delivery === "pending" &&
      (item.runId === null || !activeRunIds.has(item.runId)),
  );
}
