import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";

export function threadConversationActions(
  thread: EnvironmentThreadShell,
  capabilities: {
    threadSettlement?: boolean;
    threadSnooze?: boolean;
    threadPinning?: boolean;
    threadTitleRegeneration?: boolean;
  },
  now: string,
  queued: boolean,
) {
  const actions: Array<{
    id:
      | "rename"
      | "regenerate"
      | "pin"
      | "unpin"
      | "settle"
      | "unsettle"
      | "snooze"
      | "unsnooze"
      | "archive"
      | "unarchive"
      | "delete";
    title: string;
    icon: string;
    disabled?: boolean;
  }> = [];
  if (thread.archivedAt !== null)
    return [
      { id: "unarchive" as const, title: "Unarchive", icon: "arrow.uturn.backward" },
      { id: "delete" as const, title: "Delete", icon: "trash" },
    ];
  actions.push({ id: "rename", title: "Rename", icon: "square.and.pencil" });
  if (capabilities.threadTitleRegeneration)
    actions.push({
      id: "regenerate",
      title: "Regenerate title",
      icon: "arrow.trianglehead.2.clockwise",
      disabled: thread.titleRegeneration != null,
    });
  if (capabilities.threadPinning)
    actions.push(
      thread.pinnedAt != null
        ? { id: "unpin", title: "Unpin", icon: "pin.slash" }
        : { id: "pin", title: "Pin", icon: "pin" },
    );
  if (capabilities.threadSettlement)
    actions.push(
      thread.settledOverride === "settled" && !queued
        ? { id: "unsettle", title: "Unsettle", icon: "arrow.uturn.backward" }
        : { id: "settle", title: "Settle", icon: "checkmark" },
    );
  if (capabilities.threadSnooze) {
    if (effectiveSnoozed(thread, { now }))
      actions.push({ id: "unsnooze", title: "Wake now", icon: "sun.max" });
    else if (!queued && canSnooze(thread, { now }))
      actions.push({ id: "snooze", title: "Snooze…", icon: "clock" });
  }
  actions.push(
    { id: "archive", title: "Archive", icon: "archivebox" },
    { id: "delete", title: "Delete", icon: "trash" },
  );
  return actions;
}

/** A delayed mutation may finish after navigation has changed the visible target. */
export function threadActionCanReturnHome(
  params: object | undefined,
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id">,
): boolean {
  return (
    params !== undefined &&
    "environmentId" in params &&
    params.environmentId === thread.environmentId &&
    "threadId" in params &&
    params.threadId === thread.id
  );
}
