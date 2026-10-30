import type {
  CheckpointId,
  MessageId,
  NodeId,
  OrchestrationV2Checkpoint,
  OrchestrationV2DomainEvent,
  OrchestrationV2ContextHandoff,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  dedupeSubagentBodies,
  dedupeTurnItemBodies,
} from "@t3tools/shared/orchestrationV2DedupedBodies";
import {
  compactDynamicToolOutput,
  omitToolOutputImageData,
  toolOutputImages,
  toolOutputIndicatesFailure,
} from "@t3tools/shared/toolOutput";

// A checkpoint over vendored or generated trees can list 15k+ files; the card needs a prefix.
const MAX_WIRE_CHECKPOINT_FILES = 200;
const MAX_DETAIL_STRING_BYTES = 32_768;
const MAX_DYNAMIC_VALUE_BYTES = 16_384;
const MAX_ON_DEMAND_BYTES = 256 * 1024;

function truncateDetail(
  value: string | undefined,
  maxBytes = MAX_DETAIL_STRING_BYTES,
): string | undefined {
  if (
    value === undefined ||
    (value.length <= maxBytes && Buffer.byteLength(value, "utf8") <= maxBytes)
  ) {
    return value;
  }
  // UTF-8 needs at least one byte per UTF-16 unit; encode only a potentially fitting prefix.
  const prefix = Buffer.from(value.slice(0, maxBytes), "utf8")
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return `${prefix}\n… output truncated for transport`;
}

/** Bound stored diffs to the client wire limit to avoid retaining invisible data in SQLite and heap. */
export function boundFileChangeForStorage(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type !== "file_change") return item;
  const { diffStr, oldStr, newStr } = item;
  const bounded = {
    ...item,
    ...(diffStr === undefined ? {} : { diffStr: truncateDetail(diffStr) }),
    ...(oldStr === undefined ? {} : { oldStr: truncateDetail(oldStr) }),
    ...(newStr === undefined ? {} : { newStr: truncateDetail(newStr) }),
  };
  return bounded.diffStr === diffStr && bounded.oldStr === oldStr && bounded.newStr === newStr
    ? item
    : bounded;
}

function summarizeDynamicValue(value: unknown): unknown {
  let serialized: string;
  try {
    if (typeof value === "string" && value.length > MAX_DYNAMIC_VALUE_BYTES) {
      serialized = value;
    } else {
      const json = JSON.stringify(value) ?? String(value);
      if (Buffer.byteLength(json, "utf8") <= MAX_DYNAMIC_VALUE_BYTES) {
        return value;
      }
      serialized = typeof value === "string" ? value : json;
    }
  } catch {
    serialized = "Unserializable tool output";
  }

  // Splitting and normalizing every line can allocate far more than the input.
  const start = /\S/u.exec(serialized)?.index;
  let firstLine = start === undefined ? "Large tool output" : "";
  let pendingSpace = false;
  for (let index = start ?? serialized.length; index < serialized.length; index += 1) {
    const character = serialized[index]!;
    if (character === "\n") break;
    if (/\s/u.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace) firstLine += " ";
    firstLine += character;
    pendingSpace = false;
    if (firstLine.length > 160) break;
  }
  return {
    summary: firstLine.length <= 160 ? firstLine : `${firstLine.slice(0, 159).trimEnd()}…`,
    truncated: true,
  };
}

type CheckpointFiles = Pick<OrchestrationV2Checkpoint, "files" | "filesTotal">;

// Same input, same output object: snapshot compaction relies on shared item identity.
const cappedCheckpointFiles = new WeakMap<object, object>();

function capCheckpointFiles<T extends CheckpointFiles>(value: T): T {
  if (value.files.length <= MAX_WIRE_CHECKPOINT_FILES || value.filesTotal !== undefined) {
    return value;
  }
  const cached = cappedCheckpointFiles.get(value);
  if (cached !== undefined) return cached as T;
  let additions = 0;
  let deletions = 0;
  for (const file of value.files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  const capped = {
    ...value,
    files: value.files.slice(0, MAX_WIRE_CHECKPOINT_FILES),
    filesTotal: { count: value.files.length, additions, deletions },
  };
  cappedCheckpointFiles.set(value, capped);
  return capped;
}

/** Idempotent; bounded snapshots that skip `projectThreadProjectionForWire` still need it. */
export function capProjectionCheckpointFilesForWire(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  const checkpoints = projection.checkpoints.map(capCheckpointFiles);
  const turnItems = projection.turnItems.map(capCheckpointItemFiles);
  const visibleTurnItems = projection.visibleTurnItems.map((row) => {
    const item = capCheckpointItemFiles(row.item);
    return item === row.item ? row : { ...row, item };
  });
  const unchanged = (next: ReadonlyArray<unknown>, previous: ReadonlyArray<unknown>) =>
    next.every((value, index) => value === previous[index]);
  return unchanged(checkpoints, projection.checkpoints) &&
    unchanged(turnItems, projection.turnItems) &&
    unchanged(visibleTurnItems, projection.visibleTurnItems)
    ? projection
    : { ...projection, checkpoints, turnItems, visibleTurnItems };
}

function capCheckpointItemFiles(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  return item.type === "checkpoint" ? capCheckpointFiles(item) : item;
}

export function projectTurnItemForWire(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "checkpoint":
      return capCheckpointFiles(item);
    case "handoff": {
      const { summary: _summary, ...projected } = item;
      return projected;
    }
    case "command_execution": {
      const { output, ...projected } = item;
      const failed =
        item.outputIndicatesFailure === true ||
        (item.exitCode !== undefined && item.exitCode !== 0) ||
        (output !== undefined &&
          toolOutputIndicatesFailure(output.slice(0, MAX_DETAIL_STRING_BYTES)));
      return {
        ...projected,
        ...(failed ? { outputIndicatesFailure: true } : {}),
        ...(output?.trim() ? { outputOmitted: true } : {}),
      };
    }
    case "file_change": {
      const { diffStr, oldStr: _old, newStr: _new, ...projected } = item;
      return item.status === "failed" && diffStr?.trim()
        ? { ...projected, diffStr: truncateDetail(diffStr) }
        : projected;
    }
    case "subagent":
      return {
        ...item,
        prompt: truncateDetail(item.prompt) ?? "",
        progress: truncateDetail(item.progress),
        result: item.result === null ? null : (truncateDetail(item.result) ?? null),
      };
    case "dynamic_tool": {
      const { output: rawOutput, ...projected } = item;
      const output = compactDynamicToolOutput(rawOutput);
      return {
        ...projected,
        input: summarizeDynamicValue(item.input),
        ...(output === undefined ? {} : { output }),
        ...(hasDynamicValue(rawOutput) ? { outputOmitted: true } : {}),
      };
    }
    default:
      return item;
  }
}

function hasDynamicValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value !== "object" || Object.keys(value).length > 0;
}

function boundDynamicValue(value: unknown): unknown {
  if (value === undefined) return value;
  if (typeof value === "string") return truncateDetail(value, MAX_ON_DEMAND_BYTES);
  let json: string;
  try {
    json = JSON.stringify(value) ?? String(value);
  } catch {
    return "Unserializable tool value";
  }
  return Buffer.byteLength(json, "utf8") <= MAX_ON_DEMAND_BYTES
    ? value
    : truncateDetail(json, MAX_ON_DEMAND_BYTES);
}

/** Preserve ordered image markers in truncated output so clients can load images by index. */
function boundToolOutput(output: unknown): unknown {
  const omitted = omitToolOutputImageData(output);
  const bounded = boundDynamicValue(omitted);
  if (typeof bounded !== "string" || typeof omitted === "string") return bounded;
  const images = toolOutputImages(omitted);
  return images.length === 0
    ? bounded
    : [
        { type: "text", text: bounded },
        ...images.map((image) => ({ type: "image", mimeType: image.mimeType })),
      ];
}

export function projectTurnItemForDetail(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "command_execution":
      return {
        ...item,
        input: truncateDetail(item.input, MAX_ON_DEMAND_BYTES) ?? "",
        output: truncateDetail(item.output, MAX_ON_DEMAND_BYTES),
      };
    case "dynamic_tool":
      return {
        ...item,
        input: boundDynamicValue(item.input),
        output: boundToolOutput(item.output),
      };
    case "subagent":
      return {
        ...item,
        prompt: truncateDetail(item.prompt, MAX_ON_DEMAND_BYTES) ?? "",
        progress: truncateDetail(item.progress, MAX_ON_DEMAND_BYTES),
        result:
          item.result === null ? null : (truncateDetail(item.result, MAX_ON_DEMAND_BYTES) ?? null),
      };
    case "file_change":
      return {
        ...projectTurnItemForWire(item),
        ...(item.diffStr === undefined
          ? {}
          : { diffStr: truncateDetail(item.diffStr, MAX_ON_DEMAND_BYTES) }),
        ...(!item.diffStr?.trim() && item.oldStr !== undefined
          ? { oldStr: truncateDetail(item.oldStr, MAX_ON_DEMAND_BYTES) }
          : {}),
        ...(!item.diffStr?.trim() && item.newStr !== undefined
          ? { newStr: truncateDetail(item.newStr, MAX_ON_DEMAND_BYTES) }
          : {}),
      };
    case "handoff":
      return projectTurnItemForWire(item);
    default:
      return item;
  }
}

export function projectContextHandoffForWire(
  handoff: OrchestrationV2ContextHandoff,
): OrchestrationV2ContextHandoff {
  const { history: _history, delivery: _delivery, ...projected } = handoff;
  return { ...projected, summaryText: "" };
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
    checkpoints: projection.checkpoints.map(capCheckpointFiles),
    contextHandoffs: projection.contextHandoffs.map(projectContextHandoffForWire),
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
    : event.type === "context-handoff.updated"
      ? { ...event, payload: projectContextHandoffForWire(event.payload) }
      : event.type === "checkpoint.captured"
        ? { ...event, payload: capCheckpointFiles(event.payload) }
        : event;
}

const LIVE_DEDUPE_MEMORY = 32;

function remember<K, V>(memory: Map<K, V>, key: K, value: V): void {
  memory.delete(key);
  memory.set(key, value);
  if (memory.size > LIVE_DEDUPE_MEMORY) memory.delete(memory.keys().next().value as K);
}

/**
 * One per subscription, after coalescing, so it remembers only records the client received. A
 * record event comes before the turn item that repeats its body, so the item (or a repeated
 * subagent record) ships blank and marked. The other order, or a forgotten record, only costs
 * bytes: the repeat ships whole.
 */
export function makeLiveBodyDeduper(): (
  item: OrchestrationV2ThreadStreamItem,
) => OrchestrationV2ThreadStreamItem {
  const messageText = new Map<MessageId, string>();
  const checkpointFiles = new Map<CheckpointId, OrchestrationV2Checkpoint["files"]>();
  const subagents = new Map<NodeId, Pick<OrchestrationV2Subagent, "prompt" | "result">>();
  const source = {
    messageText: (id: MessageId) => messageText.get(id),
    checkpointFiles: (id: CheckpointId) => checkpointFiles.get(id),
    subagent: (id: NodeId) => subagents.get(id),
  };
  const rememberSubagent = ({ id, prompt, result }: OrchestrationV2Subagent) =>
    remember(subagents, id, { prompt, result });
  return (item) => {
    if (item.kind === "snapshot") {
      // The client now holds exactly these records; their bodies are never blanked.
      const { messages, checkpoints, subagents: records } = item.projection;
      for (const message of messages) remember(messageText, message.id, message.text);
      for (const checkpoint of checkpoints)
        remember(checkpointFiles, checkpoint.id, checkpoint.files);
      for (const subagent of records) rememberSubagent(subagent);
      return item;
    }
    if (item.kind !== "event") return item;
    const { event } = item;
    switch (event.type) {
      case "message.updated":
        remember(messageText, event.payload.id, event.payload.text);
        return item;
      case "checkpoint.captured":
        remember(checkpointFiles, event.payload.id, event.payload.files);
        return item;
      case "subagent.updated": {
        const payload = dedupeSubagentBodies(event.payload, subagents.get(event.payload.id));
        rememberSubagent(event.payload);
        return payload === event.payload ? item : { ...item, event: { ...event, payload } };
      }
      case "turn-item.updated": {
        const payload = dedupeTurnItemBodies(event.payload, source);
        return payload === event.payload ? item : { ...item, event: { ...event, payload } };
      }
      default:
        return item;
    }
  };
}
