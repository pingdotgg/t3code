import type { MobileTaskListItem } from "./taskList";

export function isMobileTaskListItem(item: { type: string }): item is MobileTaskListItem {
  return (
    item.type === "task-card" ||
    item.type === "task-slim" ||
    item.type === "task-new-thread" ||
    item.type === "task-subshelf-header"
  );
}

/** Entity references carry status and action state; member array allocation is immaterial. */
export function mobileTaskItemsAreEqual(
  previous: MobileTaskListItem,
  next: MobileTaskListItem,
): boolean {
  if (previous.type !== next.type || previous.key !== next.key || previous.task !== next.task)
    return false;
  if (previous.type === "task-new-thread" || next.type === "task-new-thread") return true;
  if (previous.expanded !== next.expanded || previous.count !== next.count) return false;
  if (previous.type === "task-subshelf-header" || next.type === "task-subshelf-header") return true;
  return (
    previous.retainedShelfVisibleCount === next.retainedShelfVisibleCount &&
    previous.selected === next.selected &&
    previous.status === next.status &&
    previous.snoozed === next.snoozed &&
    previous.snoozeWakeLabelText === next.snoozeWakeLabelText &&
    previous.primaryProject === next.primaryProject &&
    previous.members.length === next.members.length &&
    previous.members.every((member, index) => member === next.members[index])
  );
}
