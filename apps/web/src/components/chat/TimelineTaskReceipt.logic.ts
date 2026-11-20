import {
  decodeOrbitTaskCreated,
  type OrbitTaskSummary,
} from "@t3tools/client-runtime/orbit-gateway";

import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/shell";

import type { WorkLogEntry } from "../../session-logic";

// Claude Code names the tool `mcp__orbit__task-create`; other providers say `orbit.task-create`.
const ORBIT_TASK_CREATE = /^(?:mcp__)?orbit(?:__|[./:\s]+)task[-_]create$/i;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The result as the Gateway sent it, out of a bare value, JSON text, or MCP content blocks. */
function unwrapToolOutput(output: unknown): unknown {
  if (typeof output === "string") return unwrapToolOutput(parseJson(output));
  if (Array.isArray(output)) {
    for (const block of output) {
      const text = typeof block === "object" && block !== null ? Reflect.get(block, "text") : null;
      if (typeof text === "string") return unwrapToolOutput(text);
    }
    return undefined;
  }
  if (typeof output === "object" && output !== null) {
    const record = output as Record<string, unknown>;
    if ("data" in record) return record;
    if (record.structuredContent !== undefined) return unwrapToolOutput(record.structuredContent);
    if (record.content !== undefined) return unwrapToolOutput(record.content);
  }
  return output;
}

/** The task an Orbit task-create tool item made, or null for any other item or an unreadable result. */
function orbitTaskCreateReceiptFromItem(
  item: ThreadStructureTurnItem | undefined,
): OrbitTaskSummary | null {
  if (item?.type !== "dynamic_tool" || !item.toolName) return null;
  if (!ORBIT_TASK_CREATE.test(item.toolName.trim())) return null;
  return decodeOrbitTaskCreated(unwrapToolOutput(item.output));
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
