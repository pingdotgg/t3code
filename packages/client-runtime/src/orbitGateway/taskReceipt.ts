import type { OrbitTaskSummary } from "./tasks.ts";
import { decodeOrbitTaskCreated } from "./tasksWire.ts";

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
    // The wire keeps only the task's row (compactDynamicToolOutput), not the whole result.
    if (record.orbitTask !== undefined) return { data: record.orbitTask };
    if (record.structuredContent !== undefined) return unwrapToolOutput(record.structuredContent);
    if (record.content !== undefined) return unwrapToolOutput(record.content);
  }
  return output;
}

/** The task an Orbit task-create tool call made, or null for any other tool or an unreadable result. */
export function orbitTaskCreateReceiptFromTool(
  toolName: string | null | undefined,
  output: unknown,
): OrbitTaskSummary | null {
  if (!toolName || !ORBIT_TASK_CREATE.test(toolName.trim())) return null;
  return decodeOrbitTaskCreated(unwrapToolOutput(output));
}
