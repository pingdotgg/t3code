import {
  orbitTaskCreateReceiptFromTool,
  type OrbitTaskSummary,
} from "@t3tools/client-runtime/orbit-gateway";

import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/shell";

import type { WorkLogEntry } from "../../session-logic";

/** The task an Orbit task-create tool item made, or null for any other item or an unreadable result. */
function orbitTaskCreateReceiptFromItem(
  item: ThreadStructureTurnItem | undefined,
): OrbitTaskSummary | null {
  if (item?.type !== "dynamic_tool") return null;
  return orbitTaskCreateReceiptFromTool(item.toolName, item.output);
}

/** The task an Orbit task-create call made, or null for any other entry or an unreadable result. */
export function orbitTaskCreateReceipt(
  entry: Pick<WorkLogEntry, "structuredPayload">,
): OrbitTaskSummary | null {
  return orbitTaskCreateReceiptFromItem(entry.structuredPayload);
}

/** Every task the thread's visible tool calls created, in creation order, once per task. */
export function threadCreatedTasks(
  items: ReadonlyArray<{ readonly item: ThreadStructureTurnItem }>,
): ReadonlyArray<OrbitTaskSummary> {
  const byId = new Map<number, OrbitTaskSummary>();
  for (const { item } of items) {
    const task = orbitTaskCreateReceiptFromItem(item);
    if (task && !byId.has(task.id)) byId.set(task.id, task);
  }
  return [...byId.values()];
}
