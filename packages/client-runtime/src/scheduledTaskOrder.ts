import { ScheduledTaskId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const ScheduledTaskOrder = Schema.Array(ScheduledTaskId);

export function orderScheduledTasks<Task extends { readonly id: ScheduledTaskId }>(
  tasks: readonly Task[],
  savedOrder: readonly ScheduledTaskId[] | undefined,
) {
  if (!savedOrder?.length) return tasks;
  const positions = new Map(savedOrder.map((id, index) => [id, index]));
  return [...tasks].sort((a, b) => (positions.get(a.id) ?? -1) - (positions.get(b.id) ?? -1));
}

export function moveScheduledTask(
  orderedTasks: readonly { readonly id: ScheduledTaskId }[],
  visibleIds: ReadonlySet<ScheduledTaskId>,
  fromId: ScheduledTaskId,
  toId: ScheduledTaskId,
) {
  const visible = orderedTasks.filter((task) => visibleIds.has(task.id)).map((task) => task.id);
  const from = visible.indexOf(fromId);
  const to = visible.indexOf(toId);
  if (from === -1 || to === -1 || from === to) return;
  visible.splice(from, 1);
  visible.splice(to, 0, fromId);
  // A filtered drag swaps only the slots occupied by visible tasks.
  let index = 0;
  return orderedTasks.map((task) => (visibleIds.has(task.id) ? visible[index++]! : task.id));
}
