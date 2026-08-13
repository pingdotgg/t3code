import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

const MAX_DETAIL_STRING_BYTES = 32_768;
const MAX_DYNAMIC_VALUE_BYTES = 16_384;

function encodedBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return Buffer.byteLength(serialized ?? String(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function truncateDetail(value: string | undefined): string | undefined {
  if (value === undefined || Buffer.byteLength(value, "utf8") <= MAX_DETAIL_STRING_BYTES) {
    return value;
  }
  const prefix = Buffer.from(value, "utf8")
    .subarray(0, MAX_DETAIL_STRING_BYTES)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return `${prefix}\n… output truncated for transport`;
}

function summarizeDynamicValue(value: unknown): unknown {
  if (encodedBytes(value) <= MAX_DYNAMIC_VALUE_BYTES) {
    return value;
  }
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    serialized = "Unserializable tool output";
  }
  const firstLine =
    serialized
      .split(/\r?\n/u)
      .map((line) => line.replace(/\s+/gu, " ").trim())
      .find((line) => line.length > 0) ?? "Large tool output";
  return {
    summary: firstLine.length <= 160 ? firstLine : `${firstLine.slice(0, 159).trimEnd()}…`,
    truncated: true,
  };
}

export function projectTurnItemForWire(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "command_execution":
      return { ...item, output: truncateDetail(item.output) };
    case "file_change":
      return {
        ...item,
        diffStr: truncateDetail(item.diffStr),
        oldStr: truncateDetail(item.oldStr),
        newStr: truncateDetail(item.newStr),
      };
    case "subagent":
      return {
        ...item,
        prompt: truncateDetail(item.prompt) ?? "",
        progress: truncateDetail(item.progress),
        result: item.result === null ? null : (truncateDetail(item.result) ?? null),
      };
    case "dynamic_tool":
      return {
        ...item,
        input: summarizeDynamicValue(item.input),
        ...(item.output === undefined ? {} : { output: summarizeDynamicValue(item.output) }),
      };
    default:
      return item;
  }
}

export function projectThreadProjectionForWire(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  const projectedById = new Map<string, OrchestrationV2TurnItem>();
  const project = (item: OrchestrationV2TurnItem) => {
    const key = `${item.threadId}:${item.id}`;
    const existing = projectedById.get(key);
    if (existing !== undefined) return existing;
    const projected = projectTurnItemForWire(item);
    projectedById.set(key, projected);
    return projected;
  };
  return {
    ...projection,
    turnItems: projection.turnItems.map(project),
    visibleTurnItems: projection.visibleTurnItems.map((row) => ({
      ...row,
      item: project(row.item),
    })),
  };
}

export function projectDomainEventForWire(
  event: OrchestrationV2DomainEvent,
): OrchestrationV2DomainEvent {
  return event.type === "turn-item.updated"
    ? { ...event, payload: projectTurnItemForWire(event.payload) }
    : event;
}
