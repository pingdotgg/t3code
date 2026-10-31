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
  commandRunsTests,
  compactDynamicToolOutput,
  countFailedTests,
  omitToolOutputImageData,
  toolOutputImages,
  toolOutputIndicatesFailure,
} from "./toolOutput.ts";

/**
 * What a turn item looks like on the wire. The server strips heavy payloads
 * (command output, full diffs, handoff history) before sending, so clients
 * render only what survives here. Shared so client fixtures pass through the
 * same projection the server applies.
 */

// A checkpoint over vendored or generated trees can list 15k+ files; the card needs a prefix.
const MAX_WIRE_CHECKPOINT_FILES = 200;
const MAX_DETAIL_STRING_BYTES = 32_768;
const MAX_DYNAMIC_VALUE_BYTES = 16_384;
const MAX_ON_DEMAND_BYTES = 256 * 1024;
const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

function utf8ByteLength(value: string): number {
  return utf8.encode(value).byteLength;
}
const TRUNCATION_MARKER = "\n… output truncated for transport";
const TRUNCATION_MARKER_BYTES = utf8ByteLength(TRUNCATION_MARKER);

function truncateDetail(
  value: string | undefined,
  maxBytes = MAX_DETAIL_STRING_BYTES,
): string | undefined {
  if (value === undefined || (value.length <= maxBytes && utf8ByteLength(value) <= maxBytes)) {
    return value;
  }
  // The marker counts toward the cap, so projecting truncated text again leaves it unchanged.
  const budget = maxBytes - TRUNCATION_MARKER_BYTES;
  // UTF-8 needs at least one byte per UTF-16 unit; encode only a potentially fitting prefix.
  const prefix = utf8Decoder
    .decode(utf8.encode(value.slice(0, budget)).subarray(0, budget))
    .replace(/\uFFFD$/u, "");
  return `${prefix}${TRUNCATION_MARKER}`;
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
      if (utf8ByteLength(json) <= MAX_DYNAMIC_VALUE_BYTES) {
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

interface LineCounts {
  readonly additions: number;
  readonly deletions: number;
}

function countTextLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

function countPatchLines(lines: ReadonlyArray<unknown>): LineCounts {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (typeof line !== "string") continue;
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

/** Counts lines outside the unchanged head and tail, exact for one contiguous edit. */
function countReplacementLines(oldText: string, newText: string): LineCounts {
  const before = oldText.length === 0 ? [] : oldText.split("\n");
  const after = newText.length === 0 ? [] : newText.split("\n");
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  return { additions: after.length - head - tail, deletions: before.length - head - tail };
}

/**
 * Counts the `lines` of a JSON `structuredPatch` in place. Claude's Edit result
 * also carries the whole original file, so parsing the full JSON per item
 * would cost far more than scanning the patch array.
 */
function countStructuredPatchLines(json: string): LineCounts | null {
  const key = json.indexOf('"structuredPatch":');
  if (key < 0) return null;
  let index = json.indexOf("[", key);
  if (index < 0) return null;
  let additions = 0;
  let deletions = 0;
  let depth = 0;
  let lines = 0;
  for (; index < json.length; index += 1) {
    const char = json[index];
    if (char === '"') {
      // Strings at depth 3 are the elements of a hunk's `lines` array.
      if (depth === 3) {
        const marker = json[index + 1];
        if (marker === "+") additions += 1;
        else if (marker === "-") deletions += 1;
        lines += 1;
      }
      for (index += 1; index < json.length && json[index] !== '"'; index += 1) {
        if (json[index] === "\\") index += 1;
      }
    } else if (char === "[" || char === "{") {
      depth += 1;
    } else if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return lines === 0 ? null : { additions, deletions };
}

/**
 * Line counts for providers that report a diff without counts: unified hunks
 * (Codex, ACP, OpenCode), the JSON Edit/Write result Claude returns (a
 * structured patch, or the content of a created file), and old/new text.
 */
function fileChangeLineCounts(
  item: Extract<OrchestrationV2TurnItem, { readonly type: "file_change" }>,
): LineCounts | null {
  const diff = item.diffStr?.trim();
  // Codex reports added/deleted file contents directly, including blank lines.
  const operation = item.changes?.length === 1 ? item.changes[0]?.operation : undefined;
  if (
    item.diffStr !== undefined &&
    (operation === "add" || operation === "delete") &&
    !/^@@ /m.test(item.diffStr)
  ) {
    const lines = countTextLines(item.diffStr);
    return operation === "add"
      ? { additions: lines, deletions: 0 }
      : { additions: 0, deletions: lines };
  }
  if (diff) {
    if (!diff.startsWith("{")) {
      return /^@@ /m.test(diff) ? countPatchLines(diff.split("\n")) : null;
    }
    const patch = countStructuredPatchLines(diff);
    if (patch !== null) return patch;
    if (!diff.startsWith('{"type":"create"')) return null;
    try {
      const parsed: unknown = JSON.parse(diff);
      return typeof parsed === "object" &&
        parsed !== null &&
        "content" in parsed &&
        typeof parsed.content === "string"
        ? { additions: countTextLines(parsed.content), deletions: 0 }
        : null;
    } catch {
      return null;
    }
  }
  if (item.oldStr !== undefined || item.newStr !== undefined) {
    return countReplacementLines(item.oldStr ?? "", item.newStr ?? "");
  }
  return null;
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
      // A successful search can print "ENOENT" or "exit code 2", so output text
      // decides only when the provider reported no exit code.
      const failed =
        item.exitCode === undefined
          ? item.outputIndicatesFailure === true ||
            (output !== undefined &&
              toolOutputIndicatesFailure(output.slice(0, MAX_DETAIL_STRING_BYTES)))
          : item.exitCode !== 0;
      const outputPresence = output?.trim() ? { outputOmitted: true } : {};
      if (!failed) return { ...projected, ...outputPresence };
      // Runner summaries sit at the end of the output the wire drops.
      const failedTestCount =
        output !== undefined && commandRunsTests(item.input)
          ? countFailedTests(output.slice(-MAX_DETAIL_STRING_BYTES))
          : undefined;
      return {
        ...projected,
        outputIndicatesFailure: true,
        ...outputPresence,
        ...(failedTestCount === undefined ? {} : { failedTestCount }),
      };
    }
    case "file_change": {
      const { diffStr, oldStr: _old, newStr: _new, ...projected } = item;
      if (item.status === "failed" && diffStr?.trim()) {
        return { ...projected, diffStr: truncateDetail(diffStr) };
      }
      if (item.additions !== undefined || item.deletions !== undefined) return projected;
      const counts = fileChangeLineCounts(item);
      return counts === null ? projected : { ...projected, ...counts };
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
  return utf8ByteLength(json) <= MAX_ON_DEMAND_BYTES
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
