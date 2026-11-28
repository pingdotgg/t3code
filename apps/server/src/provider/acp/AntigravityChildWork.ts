// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite reads the native session database read-only.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import type {
  OrchestrationV2NativeChildStep,
  OrchestrationV2NativeChildWork,
} from "@t3tools/contracts";
import type { AcpSubagentTranscriptEntry } from "@t3tools/provider-acp/server/adapter";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";
import {
  boundAntigravityToolText,
  isCutAntigravityToolText,
  sanitizeAntigravityToolPayload,
} from "./AntigravityProtocol.ts";

// Field numbers from the runtime's trajectory protos (exa.cortex_pb).
const STEP_METADATA = 5;
const METADATA_TOOL_CALL = 4;
const STEP_PLANNER_RESPONSE = 20;
const PLANNER_TOOL_CALLS = 7;
const STEP_INVOKE_SUBAGENT = 143;
const INVOKE_SPECS = 9;
const INVOKE_RESULTS = 10;
const INVOKE_SUBAGENT_STEP_TYPE = 127;

// One open reads at most this much; past any bound the batch view stays as it was.
const MAX_STEP_BYTES = 1024 * 1024;
const MAX_INVOKE_ROWS = 200;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_CHILDREN = 16;
const TRANSCRIPT_BYTE_CAP = 256 * 1024;
const BATCH_TRANSCRIPT_BYTES = 512 * 1024;
const STEP_TEXT_CAP = 4_000;
const TOOL_INPUT_CAP = 1_000;
const MAX_MESSAGE_FILES = 256;
const MAX_DETACHED_CHILDREN = 64;

/** T3's title for a batch whose launch text it never saw. */
export const ANTIGRAVITY_SUBAGENT_BATCH_TITLE = "Antigravity subagent batch";

interface AntigravityChildLaunch {
  readonly role: string;
  readonly prompt: string;
}

const LaunchInput = Schema.Struct({ Role: Schema.String, Prompt: Schema.String });
const SwarmAddInput = Schema.Struct({
  action: Schema.String,
  name: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  brief: Schema.optional(Schema.String),
  n: Schema.optional(Schema.Number),
  tasks: Schema.optional(Schema.Array(Schema.String)),
});
// agy 1.5 launches one child per call with a flat input; earlier releases send a batch.
const decodeLaunchInput = Schema.decodeUnknownOption(
  Schema.Union([Schema.Struct({ Subagents: Schema.NonEmptyArray(LaunchInput) }), LaunchInput]),
);
const decodeSwarmAddInput = Schema.decodeUnknownOption(SwarmAddInput);

// The tool input is untrusted; a huge `n` must not allocate a launch per requested worker.
const MAX_SWARM_ADD_LAUNCHES = 64;

function swarmAddLaunches(input: unknown): ReadonlyArray<AntigravityChildLaunch> | undefined {
  const decoded = Option.getOrUndefined(decodeSwarmAddInput(input));
  if (decoded === undefined || decoded.action.trim().toLowerCase() !== "add") return undefined;
  const baseName = decoded.name?.trim().replace(/^@/, "") ?? "";
  const brief = decoded.brief?.trim() ?? "";
  const tasks = decoded.tasks ?? [];
  const requestedCount =
    decoded.n !== undefined && Number.isFinite(decoded.n) ? Math.trunc(decoded.n) : 0;
  const count = Math.min(Math.max(tasks.length, requestedCount, 1), MAX_SWARM_ADD_LAUNCHES);
  const roleSuffix =
    decoded.role !== undefined && decoded.role.trim().length > 0 && decoded.role !== "worker"
      ? ` (${decoded.role.trim()})`
      : "";

  if (count === 1) {
    const task = tasks[0]?.trim() ?? "";
    const prompt = brief.length > 0 && task.length > 0 ? `${brief}\n\n${task}` : brief || task;
    return [
      {
        role: baseName.length > 0 ? `@${baseName}${roleSuffix}` : `Swarm worker${roleSuffix}`,
        prompt,
      },
    ];
  }

  return Array.from({ length: count }, (_, index) => {
    const task = tasks[index]?.trim() ?? "";
    const prompt = brief.length > 0 && task.length > 0 ? `${brief}\n\n${task}` : task || brief;
    const role =
      baseName.length > 0
        ? `@${baseName}-${index + 1}${roleSuffix}`
        : `Swarm worker ${index + 1}${roleSuffix}`;
    return { role, prompt };
  });
}

/** `invoke_subagent` or native `swarm` (`action: "add"`) arguments. */
export function antigravitySubagentLaunches(
  input: unknown,
): ReadonlyArray<AntigravityChildLaunch> | undefined {
  const classic = Option.getOrUndefined(
    Option.map(decodeLaunchInput(input), (decoded) =>
      ("Subagents" in decoded ? decoded.Subagents : [decoded]).map((entry) => ({
        role: entry.Role,
        prompt: entry.Prompt,
      })),
    ),
  );
  return classic ?? swarmAddLaunches(input);
}

/** Batch title and prompt; reads match permission-prompt tool call ids against this exact text. */
export function describeAntigravitySubagentLaunches(
  launches: ReadonlyArray<AntigravityChildLaunch>,
) {
  const [only] = launches;
  return launches.length === 1 && only !== undefined
    ? { title: only.role, prompt: only.prompt }
    : {
        title: launches.map((launch) => launch.role).join(", "),
        prompt: launches.map((launch) => `${launch.role}\n${launch.prompt}`).join("\n\n"),
      };
}

/** Length-delimited fields only; varints and fixed values are skipped. */
export function protoFields(bytes: Uint8Array): ReadonlyArray<readonly [number, Uint8Array]> {
  const fields: Array<readonly [number, Uint8Array]> = [];
  let offset = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = bytes[offset++];
      if (byte === undefined) throw new Error("Truncated varint");
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    throw new Error("Overlong varint");
  };
  while (offset < bytes.length) {
    const key = varint();
    const wire = key % 8;
    const field = Math.floor(key / 8);
    if (wire === 0) varint();
    else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else if (wire === 2) {
      const length = varint();
      if (offset + length > bytes.length) throw new Error("Truncated field");
      fields.push([field, bytes.subarray(offset, offset + length)]);
      offset += length;
    } else throw new Error("Unsupported wire type");
  }
  if (offset > bytes.length) throw new Error("Truncated field");
  return fields;
}

// Keep a leading byte order mark: T3 stores launch text with it.
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const messages = (bytes: Uint8Array, field: number) =>
  protoFields(bytes).flatMap(([number, value]) => (number === field ? [value] : []));
const message = (bytes: Uint8Array | undefined, field: number) =>
  bytes === undefined ? undefined : messages(bytes, field)[0];
const text = (bytes: Uint8Array | undefined, field: number) => {
  const value = message(bytes, field);
  return value === undefined ? undefined : textDecoder.decode(value);
};

interface InvokeRecord {
  readonly toolCallId: string | undefined;
  readonly launches: ReadonlyArray<AntigravityChildLaunch>;
  readonly children: ReadonlyArray<{
    readonly conversationId: string;
    readonly logUri?: string | undefined;
  }>;
}

const NATIVE_ID = /^[A-Za-z0-9-]{1,64}$/;

/** Undefined for steps this reader cannot decode, so they never count as proof. */
const safely =
  <A>(decode: (payload: Uint8Array) => A) =>
  (payload: Uint8Array): A | undefined => {
    try {
      return decode(payload);
    } catch {
      return undefined;
    }
  };

const decodeInvokeRecord = safely((payload): InvokeRecord | undefined => {
  const invoke = message(payload, STEP_INVOKE_SUBAGENT);
  if (invoke === undefined) return undefined;
  const children = messages(invoke, INVOKE_RESULTS).map((result) => ({
    conversationId: text(result, 1) ?? "",
    logUri: text(result, 2) ?? "",
  }));
  if (!children.every((child) => NATIVE_ID.test(child.conversationId))) return undefined;
  return {
    toolCallId: text(message(message(payload, STEP_METADATA), METADATA_TOOL_CALL), 1),
    launches: messages(invoke, INVOKE_SPECS).map((spec) => ({
      role: text(spec, 2) ?? "",
      prompt: text(spec, 3) ?? "",
    })),
    children,
  };
});

const plannerInvokeCallIds = safely((payload): ReadonlyArray<string> => {
  const planner = message(payload, STEP_PLANNER_RESPONSE);
  if (planner === undefined) return [];
  return messages(planner, PLANNER_TOOL_CALLS).flatMap((call) => {
    const id = text(call, 1);
    return text(call, 2) === "invoke_subagent" && id !== undefined ? [id] : [];
  });
});

const payloadOf = (row: unknown) =>
  row !== null &&
  typeof row === "object" &&
  "step_payload" in row &&
  row.step_payload instanceof Uint8Array
    ? row.step_payload
    : undefined;

interface BatchLaunch {
  readonly title: string | null;
  readonly prompt: string;
}

const plannerCallIdsAt = (database: NodeSqlite.DatabaseSync, plannerIdx: number) => {
  const planner = payloadOf(
    database
      .prepare(
        "SELECT step_payload FROM steps WHERE idx = ? AND step_format = 0 AND length(step_payload) <= ?",
      )
      .get(plannerIdx, MAX_STEP_BYTES),
  );
  return planner === undefined ? undefined : plannerInvokeCallIds(planner);
};

/**
 * Auto-approved calls carry `<sessionId>:<plannerStep>`; the record with that planner call's id
 * is the proof. Permission prompts carry a random id, so the launch text must match one record
 * no auto-approved sibling claims, and no sibling may share the text.
 */
function findInvokeRecord(
  database: NodeSqlite.DatabaseSync,
  input: {
    readonly rootSessionId: string;
    readonly nativeTaskId: string;
    readonly launch: BatchLaunch;
    readonly siblings: ReadonlyArray<BatchLaunch & { readonly nativeTaskId: string }>;
  },
): InvokeRecord | undefined {
  const plannerIdxOf = (nativeTaskId: string) => {
    const stepId = /^(.+):(\d+)$/.exec(nativeTaskId);
    return stepId === null ? undefined : stepId[1] === input.rootSessionId ? Number(stepId[2]) : -1;
  };
  const plannerIdx = plannerIdxOf(input.nativeTaskId);
  if (plannerIdx !== undefined) {
    if (plannerIdx < 0) return undefined;
    const callIds = plannerCallIdsAt(database, plannerIdx) ?? [];
    const [callId] = callIds;
    if (callIds.length !== 1) return undefined;
    // The record follows the planner step that issued the call.
    let rows = 0;
    let bytes = 0;
    for (const row of database
      .prepare(
        // SQLite returns only in-bound payloads, so an oversized row never reaches this process.
        "SELECT length(step_payload) AS size, CASE WHEN length(step_payload) <= ? THEN step_payload END AS step_payload FROM steps WHERE step_type = ? AND step_format = 0 AND idx > ? ORDER BY idx",
      )
      .iterate(MAX_STEP_BYTES, INVOKE_SUBAGENT_STEP_TYPE, plannerIdx)) {
      const size = row !== null && typeof row === "object" && "size" in row ? Number(row.size) : 0;
      rows += 1;
      bytes += size;
      if (rows > MAX_INVOKE_ROWS || size > MAX_STEP_BYTES || bytes > MAX_SCAN_BYTES)
        return undefined;
      const payload = payloadOf(row);
      const record = payload === undefined ? undefined : decodeInvokeRecord(payload);
      if (record !== undefined && record.toolCallId === callId) return complete(record);
    }
    return undefined;
  }
  const totals = database
    .prepare(
      "SELECT count(*) AS rows, coalesce(sum(length(step_payload)), 0) AS bytes, coalesce(max(length(step_payload)), 0) AS largest, sum(step_format != 0) AS other FROM steps WHERE step_type = ?",
    )
    .get(INVOKE_SUBAGENT_STEP_TYPE);
  const total = (key: string) =>
    totals !== undefined && key in totals ? Number(totals[key as keyof typeof totals] ?? 0) : 0;
  const sameText = (launch: BatchLaunch) =>
    launch.title === input.launch.title && launch.prompt === input.launch.prompt;
  if (
    input.siblings.some(sameText) ||
    total("rows") > MAX_INVOKE_ROWS ||
    total("bytes") > MAX_SCAN_BYTES ||
    total("largest") > MAX_STEP_BYTES ||
    total("other") > 0
  ) {
    return undefined;
  }
  const claimed = new Set<string>();
  for (const sibling of input.siblings) {
    const idx = plannerIdxOf(sibling.nativeTaskId);
    // A sibling whose launch text is missing, or cut under the same roles, or whose planner step
    // is unreadable, cannot be ruled out.
    if (idx === undefined) {
      if (
        sibling.title === ANTIGRAVITY_SUBAGENT_BATCH_TITLE ||
        (sibling.title !== null && isCutAntigravityToolText(sibling.title)) ||
        (isCutAntigravityToolText(sibling.prompt) &&
          (sibling.title === null || sibling.title === input.launch.title))
      )
        return undefined;
      continue;
    }
    if (idx < 0) continue;
    const callIds = plannerCallIdsAt(database, idx);
    if (callIds === undefined || callIds.length === 0) return undefined;
    for (const callId of callIds) claimed.add(callId);
  }
  const matches: Array<InvokeRecord> = [];
  for (const row of database
    .prepare("SELECT step_payload FROM steps WHERE step_type = ? ORDER BY idx")
    .iterate(INVOKE_SUBAGENT_STEP_TYPE)) {
    const payload = payloadOf(row);
    const record = payload === undefined ? undefined : decodeInvokeRecord(payload);
    // An unreadable record could be an identical launch, so uniqueness is unproven.
    if (record === undefined) return undefined;
    if (record.toolCallId !== undefined && claimed.has(record.toolCallId)) continue;
    // T3 stored the launch from the bounded tool payload, so bound the record the same way.
    const described = describeAntigravitySubagentLaunches(
      record.launches.map((launch) => ({
        role: boundAntigravityToolText(launch.role),
        prompt: boundAntigravityToolText(launch.prompt),
      })),
    );
    if (sameText(described)) {
      matches.push(record);
    }
  }
  const [match] = matches;
  return matches.length === 1 && match !== undefined ? complete(match) : undefined;
}

const complete = (record: InvokeRecord) =>
  record.launches.length === record.children.length && record.children.length <= MAX_CHILDREN
    ? record
    : undefined;

const TranscriptLine = Schema.Struct({
  step_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  source: Schema.optional(Schema.String),
  type: Schema.String,
  status: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  tool_calls: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, args: Schema.optional(Schema.Unknown) })),
  ),
});
type TranscriptStep = Schema.Schema.Type<typeof TranscriptLine>;
const decodeTranscriptLine = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptLine));

const REASONING_TEXT_CAP = 16_000;
const ASSISTANT_TEXT_CAP = 32_000;
const TOOL_OUTPUT_CAP = 8_000;

const READ_TOOL_NAMES = new Set([
  "read_file",
  "view_file",
  "view_file_outline",
  "view_code_item",
  "list_dir",
]);
const EDIT_TOOL_NAMES = new Set([
  "edit_file",
  "write_file",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
]);
const EXECUTE_TOOL_NAMES = new Set(["run_command", "bash", "shell"]);
const FILE_SEARCH_TOOL_NAMES = new Set(["grep_search", "find_by_name", "glob", "ripgrep"]);
const WEB_SEARCH_TOOL_NAMES = new Set(["search_web", "web_search"]);
const WEB_FETCH_TOOL_NAMES = new Set(["read_url_content", "fetch_url"]);

const NON_TOOL_RESULT_STEP_TYPES = new Set([
  "PLANNER_RESPONSE",
  "SYSTEM_MESSAGE",
  "USER_INPUT",
  "CHECKPOINT",
  "ERROR_MESSAGE",
]);

function parseTranscriptTimestamp(value: string | undefined): DateTime.Utc | undefined {
  return value === undefined ? undefined : Option.getOrUndefined(DateTime.make(value));
}

function stringField(
  record: Record<string, unknown> | undefined,
  keys: ReadonlyArray<string>,
): string | undefined {
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function rawStringField(
  record: Record<string, unknown> | undefined,
  keys: ReadonlyArray<string>,
): string | undefined {
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

// Linear scan: transcript content is untrusted and can be hundreds of KiB, so no backtracking regex.
function deliveredSystemMessageBody(content: string): string | undefined {
  const openTag = "<SYSTEM_MESSAGE>";
  for (
    let open = content.indexOf(openTag);
    open !== -1;
    open = content.indexOf(openTag, open + 1)
  ) {
    let start = open + openTag.length;
    let sawNewline = false;
    while (start < content.length && /\s/u.test(content[start]!)) {
      if (content[start] === "\n") sawNewline = true;
      start += 1;
    }
    if (!sawNewline || !content.startsWith("[Message]", start)) continue;
    const close = content.indexOf("</SYSTEM_MESSAGE>", start);
    return content.slice(start, close === -1 ? undefined : close).trim();
  }
  return undefined;
}

/** Extracts the delivered body from an inter-agent `<SYSTEM_MESSAGE>[Message] ... content=...</SYSTEM_MESSAGE>`. */
function extractDeliveredSystemMessage(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  const inner =
    deliveredSystemMessageBody(content) ??
    (content.trimStart().startsWith("[Message]") ? content.trim() : undefined);
  if (inner === undefined) return undefined;
  const contentMarker = " content=";
  const contentIndex = inner.indexOf(contentMarker);
  if (contentIndex === -1) return undefined;
  const text = inner.slice(contentIndex + contentMarker.length).trim();
  return text.length > 0 ? text : undefined;
}

/** Strips Antigravity's repeated `Created At:` / `Completed At:` header lines from `GENERIC` outputs. */
function cleanToolResultContent(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  const lines = content.split(/\r?\n/u);
  let index = 0;
  while (index < lines.length && /^(?:Created At|Completed At):\s+/u.test(lines[index] ?? "")) {
    index += 1;
  }
  const cleaned = lines.slice(index).join("\n").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function transcriptStepToolStatus(
  resultStep: TranscriptStep | undefined,
  finalize: boolean,
): {
  readonly status: NonNullable<AcpToolCallState["status"]>;
  readonly projectedStatus?: "interrupted" | undefined;
} {
  if (resultStep === undefined) {
    return finalize
      ? { status: "failed", projectedStatus: "interrupted" }
      : { status: "inProgress" };
  }
  const normalized = resultStep.status?.trim().toUpperCase();
  if (
    normalized === "ERROR" ||
    normalized === "FAILED" ||
    normalized === "CANCELED" ||
    normalized === "CANCELLED"
  ) {
    return { status: "failed" };
  }
  if (normalized === "RUNNING" || normalized === "PENDING" || normalized === "IN_PROGRESS") {
    return finalize
      ? { status: "failed", projectedStatus: "interrupted" }
      : { status: "inProgress" };
  }
  return { status: "completed" };
}

function transcriptToolCallToAcpState(input: {
  readonly toolCallId: string;
  readonly call: NonNullable<TranscriptStep["tool_calls"]>[number];
  readonly resultStep: TranscriptStep | undefined;
  readonly finalize: boolean;
}): {
  readonly toolCall: AcpToolCallState;
  readonly projectedStatus?: "interrupted" | undefined;
} {
  const decodedArgs = toolArguments(input.call.args);
  const rawInput = Predicate.isObject(decodedArgs)
    ? (decodedArgs as Record<string, unknown>)
    : undefined;
  const { status, projectedStatus } = transcriptStepToolStatus(input.resultStep, input.finalize);
  const errorText = input.resultStep?.error?.trim();
  const contentText = cleanToolResultContent(input.resultStep?.content);
  const outputText =
    status === "failed" ? errorText || contentText : (contentText ?? (errorText || undefined));
  const boundedOutput =
    outputText === undefined ? undefined : boundAntigravityToolText(outputText, TOOL_OUTPUT_CAP);
  const sanitizedInput = sanitizeAntigravityToolPayload(rawInput ?? decodedArgs);
  const sanitizedInputRecord = Predicate.isObject(sanitizedInput)
    ? (sanitizedInput as Record<string, unknown>)
    : undefined;
  const toolSummary = stringField(rawInput, ["toolSummary"]);
  const name = input.call.name.trim();
  const lower = name.toLowerCase();

  if (READ_TOOL_NAMES.has(lower)) {
    const targetPath = stringField(rawInput, [
      "Path",
      "AbsolutePath",
      "File",
      "DirectoryPath",
      "path",
      "file_path",
      "filePath",
    ]);
    return {
      projectedStatus,
      toolCall: {
        toolCallId: input.toolCallId,
        kind: "read",
        status,
        ...(targetPath === undefined ? { title: toolSummary ?? name } : {}),
        data: {
          ...(sanitizedInput === undefined ? {} : { rawInput: sanitizedInput }),
          ...(boundedOutput === undefined ? {} : { rawOutput: boundedOutput }),
          ...(targetPath === undefined ? {} : { locations: [{ path: targetPath }] }),
        },
      },
    };
  }

  if (EDIT_TOOL_NAMES.has(lower)) {
    const targetPath = stringField(rawInput, [
      "Path",
      "TargetFile",
      "AbsolutePath",
      "path",
      "file_path",
      "filePath",
    ]);
    const oldText = rawStringField(rawInput, ["Target", "TargetContent", "old_str", "oldText"]);
    const newText = rawStringField(rawInput, [
      "Replacement",
      "ReplacementContent",
      "Content",
      "CodeContent",
      "new_str",
      "newText",
    ]);
    const diffContent =
      targetPath !== undefined && newText !== undefined
        ? [
            {
              type: "diff",
              path: targetPath,
              ...(oldText === undefined
                ? {}
                : { oldText: boundAntigravityToolText(oldText, TOOL_OUTPUT_CAP) }),
              newText: boundAntigravityToolText(newText, TOOL_OUTPUT_CAP),
            },
          ]
        : undefined;
    return {
      projectedStatus,
      toolCall: {
        toolCallId: input.toolCallId,
        kind: "edit",
        status,
        ...(targetPath === undefined ? { title: toolSummary ?? name } : {}),
        data: {
          ...(sanitizedInput === undefined ? {} : { rawInput: sanitizedInput }),
          ...(boundedOutput === undefined ? {} : { rawOutput: boundedOutput }),
          ...(targetPath === undefined ? {} : { locations: [{ path: targetPath }] }),
          ...(diffContent === undefined ? {} : { content: diffContent }),
        },
      },
    };
  }

  if (EXECUTE_TOOL_NAMES.has(lower)) {
    const command = stringField(rawInput, [
      "CommandLine",
      "command_line",
      "commandLine",
      "command",
    ]);
    const cwd = stringField(rawInput, [
      "Cwd",
      "WorkingDirectory",
      "working_dir",
      "workingDir",
      "cwd",
    ]);
    return {
      projectedStatus,
      toolCall: {
        toolCallId: input.toolCallId,
        kind: "execute",
        status,
        title: toolSummary ?? command ?? name,
        ...(command === undefined ? {} : { command }),
        data: {
          ...(sanitizedInput === undefined ? {} : { rawInput: sanitizedInput }),
          ...(boundedOutput === undefined ? {} : { rawOutput: boundedOutput }),
          ...(command === undefined ? {} : { command }),
          ...(cwd === undefined ? {} : { cwd }),
        },
      },
    };
  }

  if (FILE_SEARCH_TOOL_NAMES.has(lower)) {
    const query = stringField(rawInput, ["Query", "Pattern", "query", "pattern"]);
    const searchPath = stringField(rawInput, [
      "SearchPath",
      "SearchDirectory",
      "DirectoryPath",
      "path",
      "Path",
    ]);
    const normalizedInput = {
      ...sanitizedInputRecord,
      ...(query === undefined ? {} : { query, pattern: query }),
      ...(searchPath === undefined ? {} : { path: searchPath }),
    };
    return {
      projectedStatus,
      toolCall: {
        toolCallId: input.toolCallId,
        kind: "search",
        status,
        ...(toolSummary === undefined ? {} : { title: toolSummary }),
        data: {
          rawInput: normalizedInput,
          ...(boundedOutput === undefined ? {} : { rawOutput: boundedOutput }),
          ...(searchPath === undefined ? {} : { locations: [{ path: searchPath }] }),
        },
      },
    };
  }

  if (WEB_SEARCH_TOOL_NAMES.has(lower)) {
    const query = stringField(rawInput, ["query", "Query", "search_query", "q"]);
    return {
      projectedStatus,
      toolCall: {
        toolCallId: input.toolCallId,
        kind: "search",
        status,
        title: "Web search",
        data: {
          title: "Web search",
          rawInput: {
            ...sanitizedInputRecord,
            ...(query === undefined ? {} : { query }),
          },
          ...(boundedOutput === undefined ? {} : { rawOutput: boundedOutput }),
        },
      },
    };
  }

  if (WEB_FETCH_TOOL_NAMES.has(lower)) {
    const url = stringField(rawInput, ["Url", "url", "URL"]);
    return {
      projectedStatus,
      toolCall: {
        toolCallId: input.toolCallId,
        kind: "fetch",
        status,
        title: toolSummary ?? name,
        data: {
          ...(sanitizedInput === undefined ? {} : { rawInput: sanitizedInput }),
          ...(boundedOutput === undefined ? {} : { rawOutput: boundedOutput }),
          ...(url === undefined ? {} : { locations: [{ path: url }] }),
        },
      },
    };
  }

  const title = name.startsWith("mcp_") ? `Run ${name}` : (toolSummary ?? name);
  return {
    projectedStatus,
    toolCall: {
      toolCallId: input.toolCallId,
      kind: "other",
      status,
      title,
      data: {
        ...(sanitizedInput === undefined ? {} : { rawInput: sanitizedInput }),
        ...(boundedOutput === undefined ? {} : { rawOutput: boundedOutput }),
      },
    },
  };
}

/**
 * Projects an Antigravity child conversation's `transcript.jsonl` into standard ACP subagent
 * timeline entries (thinking, typed tool calls paired with their results, follow-up user messages,
 * assistant messages, and errors).
 */
export function transcriptToSubagentEntries(
  contents: string,
  options: {
    readonly prompt: string;
    readonly childPrefix?: string | undefined;
    readonly childLabel?: string | undefined;
    readonly finalize?: boolean | undefined;
  },
): ReadonlyArray<AcpSubagentTranscriptEntry> {
  const steps = contents.split("\n").flatMap((line) => {
    const decoded = decodeTranscriptLine(line);
    return Option.isSome(decoded) ? [decoded.value] : [];
  });
  const prefix = options.childPrefix ?? "";
  const label = options.childLabel?.trim() || undefined;
  const finalize = options.finalize === true;
  const launchPrompt = options.prompt.trim();
  const entries: Array<AcpSubagentTranscriptEntry> = [];

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    const createdAt = parseTranscriptTimestamp(step.created_at);

    if (step.type === "CHECKPOINT") continue;

    if (step.type === "SYSTEM_MESSAGE") {
      if (
        step.step_index === 0 &&
        (launchPrompt === "" || step.content?.includes(launchPrompt) === true)
      ) {
        continue;
      }
      const delivered = extractDeliveredSystemMessage(step.content);
      if (delivered !== undefined) {
        entries.push({
          kind: "user_message",
          itemId: `${prefix}step:${step.step_index}:user`,
          text: capText(delivered, ASSISTANT_TEXT_CAP),
          createdAt,
        });
      }
      continue;
    }

    if (step.type === "USER_INPUT") {
      const text = step.content?.trim();
      if (text) {
        entries.push({
          kind: "user_message",
          itemId: `${prefix}step:${step.step_index}:user`,
          text: capText(text, ASSISTANT_TEXT_CAP),
          createdAt,
        });
      }
      continue;
    }

    if (step.type === "ERROR_MESSAGE") {
      const message = (step.error ?? step.content ?? "").trim();
      if (message) {
        entries.push({
          kind: "error",
          itemId: `${prefix}step:${step.step_index}:error`,
          message: capText(message, STEP_TEXT_CAP),
          createdAt,
        });
      }
      continue;
    }

    if (step.type === "PLANNER_RESPONSE") {
      const thinking = step.thinking?.trim();
      if (thinking) {
        const stepStatus = step.status?.trim().toUpperCase();
        const running =
          !finalize &&
          (stepStatus === "RUNNING" || stepStatus === "PENDING" || stepStatus === "IN_PROGRESS");
        entries.push({
          kind: "reasoning",
          itemId: `${prefix}step:${step.step_index}:thinking`,
          title: label ? `${label} · Thinking` : "Thinking",
          text: capText(thinking, REASONING_TEXT_CAP),
          status: running ? "running" : "completed",
          createdAt,
        });
      }

      const content = step.content?.trim();
      if (content) {
        const capped = capText(content, ASSISTANT_TEXT_CAP);
        entries.push({
          kind: "assistant_message",
          itemId: `${prefix}step:${step.step_index}:assistant`,
          text: label ? `**${label}**\n\n${capped}` : capped,
          createdAt,
        });
      }

      const calls = step.tool_calls ?? [];
      if (calls.length > 0) {
        // Pair each tool call 1-to-1 with the following tool-result steps until the next turn boundary.
        const resultSteps: Array<TranscriptStep> = [];
        let cursor = index + 1;
        while (cursor < steps.length && resultSteps.length < calls.length) {
          const candidate = steps[cursor]!;
          if (candidate.type === "CHECKPOINT") {
            cursor += 1;
            continue;
          }
          if (NON_TOOL_RESULT_STEP_TYPES.has(candidate.type)) break;
          resultSteps.push(candidate);
          cursor += 1;
        }
        index = cursor - 1;

        for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
          const call = calls[callIndex]!;
          const resultStep = resultSteps[callIndex];
          const itemId = `${prefix}step:${step.step_index}:tool:${callIndex}`;
          const { toolCall, projectedStatus } = transcriptToolCallToAcpState({
            toolCallId: itemId,
            call,
            resultStep,
            finalize,
          });
          entries.push({
            kind: "tool",
            itemId,
            toolCall,
            ...(projectedStatus === undefined ? {} : { projectedStatus }),
            createdAt: parseTranscriptTimestamp(resultStep?.created_at) ?? createdAt,
          });
        }
      }
      continue;
    }

    // Any standalone error step outside a planner response still surfaces visibly.
    if (step.status?.trim().toUpperCase() === "ERROR") {
      const message = (step.error ?? cleanToolResultContent(step.content) ?? "").trim();
      if (message) {
        entries.push({
          kind: "error",
          itemId: `${prefix}step:${step.step_index}:error`,
          message: capText(message, STEP_TEXT_CAP),
          createdAt,
        });
      }
    }
  }

  return entries;
}

// The runtime records each tool argument value as JSON text.
const decodeArgument = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const toolArguments = (args: unknown) =>
  Predicate.isObject(args)
    ? Object.fromEntries(
        Object.entries(args).map(([key, value]) => [
          key,
          typeof value === "string" ? Option.getOrElse(decodeArgument(value), () => value) : value,
        ]),
      )
    : (args ?? {});

const capText = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, "")}…`;

/** Skips the runtime's opening envelope around the launch prompt the view already shows. */
function transcriptSteps(
  contents: string,
  prompt: string,
): ReadonlyArray<OrchestrationV2NativeChildStep> {
  const launchPrompt = prompt.trim();
  return contents.split("\n").flatMap((line) =>
    Option.match(decodeTranscriptLine(line), {
      onNone: () => [],
      onSome: (step) =>
        step.step_index === 0 &&
        step.type === "SYSTEM_MESSAGE" &&
        launchPrompt !== "" &&
        step.content?.includes(launchPrompt) === true
          ? []
          : [
              {
                index: step.step_index,
                type: step.type,
                status: step.status ?? null,
                text:
                  step.content !== undefined || step.error !== undefined
                    ? capText(step.content ?? step.error ?? "", STEP_TEXT_CAP)
                    : null,
                toolCalls: (step.tool_calls ?? []).map((call) => ({
                  name: call.name,
                  input: capText(JSON.stringify(toolArguments(call.args)), TOOL_INPUT_CAP),
                })),
              },
            ],
    }),
  );
}

/** Reads the tail of the transcript at the named child's own unlinked profile path. */
async function readChildTranscriptRaw(
  profileRoot: string,
  child: InvokeRecord["children"][number],
  byteCap: number,
) {
  const expected = (
    await antigravityManagedPath(
      profileRoot,
      [
        "antigravity-acp",
        "brain",
        child.conversationId,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      ],
      "file",
    )
  )?.path;
  if (expected === undefined) return undefined;
  if (child.logUri !== undefined) {
    let named: string;
    try {
      named = NodeURL.fileURLToPath(child.logUri);
    } catch {
      return undefined;
    }
    if ((await NodeFSP.realpath(named).catch(() => undefined)) !== expected) return undefined;
  }
  const handle = await NodeFSP.open(
    expected,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    const tailStart = Math.max(0, stat.size - byteCap);
    // One extra byte tells whether the retained tail starts on a line boundary.
    const readStart = Math.max(0, tailStart - 1);
    const buffer = Buffer.alloc(stat.size - readStart);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, readStart);
    const bytes = buffer.subarray(0, bytesRead);
    let lineStart = 0;
    if (tailStart > 0) {
      const newline = bytes.indexOf(0x0a);
      if (newline === -1) return { contents: "", truncated: true };
      lineStart = newline + 1;
    }
    const contents = bytes.toString("utf8", lineStart);
    return { contents, truncated: tailStart > 0 };
  } finally {
    await handle.close();
  }
}

async function readChildTranscript(
  profileRoot: string,
  child: InvokeRecord["children"][number],
  prompt: string,
  byteCap: number,
) {
  const raw = await readChildTranscriptRaw(profileRoot, child, byteCap);
  if (raw === undefined) return undefined;
  return {
    steps: raw.contents.length === 0 ? [] : transcriptSteps(raw.contents, prompt),
    truncated: raw.truncated,
  };
}

class AntigravityChildWorkReadError extends Schema.TaggedError<AntigravityChildWorkReadError>()(
  "AntigravityChildWorkReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read Antigravity subagent records.";
  }
}

async function resolveAntigravityInvokeRecord(
  profileRoot: string,
  input: {
    readonly rootSessionId: string;
    readonly nativeTaskId: string;
    readonly childSessionId?: string | null | undefined;
    readonly launch: BatchLaunch;
    readonly siblings: ReadonlyArray<BatchLaunch & { readonly nativeTaskId: string }>;
  },
): Promise<InvokeRecord | undefined> {
  const detached = await findDetachedInvokeRecord(
    profileRoot,
    input.rootSessionId,
    input.nativeTaskId,
  );
  if (detached !== undefined) return detached;
  if (input.childSessionId != null && NATIVE_ID.test(input.childSessionId)) {
    return {
      toolCallId: input.nativeTaskId,
      launches: [{ role: input.launch.title ?? "", prompt: input.launch.prompt }],
      children: [{ conversationId: input.childSessionId }],
    };
  }
  const databasePath = (
    await antigravityManagedPath(
      profileRoot,
      ["antigravity-acp", "conversations", `${input.rootSessionId}.db`],
      "file",
    )
  )?.path;
  if (databasePath === undefined) return undefined;
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    return findInvokeRecord(database, input);
  } finally {
    database.close();
  }
}

/**
 * Reads standard timeline entries (thinking, typed tool calls, messages, errors) from the native
 * Antigravity child transcript(s) launched by a subagent call. Fails closed to an empty array.
 */
export const readAntigravitySubagentTranscript = Effect.fn("readAntigravitySubagentTranscript")(
  function* (input: {
    readonly profileDirectory: string;
    readonly rootSessionId: string;
    readonly nativeTaskId: string;
    readonly childSessionId?: string | null | undefined;
    readonly launch: BatchLaunch;
    readonly siblings: ReadonlyArray<BatchLaunch & { readonly nativeTaskId: string }>;
    readonly finalize?: boolean | undefined;
  }): Effect.fn.Return<ReadonlyArray<AcpSubagentTranscriptEntry>> {
    if (!NATIVE_ID.test(input.rootSessionId)) return [];
    const read = async (): Promise<ReadonlyArray<AcpSubagentTranscriptEntry>> => {
      const profileRoot = await antigravityProfileRoot(input.profileDirectory);
      if (profileRoot === undefined) return [];
      const record = await resolveAntigravityInvokeRecord(profileRoot, input);
      if (record === undefined) return [];
      const { launches, children } = record;
      const byteCap = Math.min(
        TRANSCRIPT_BYTE_CAP,
        Math.floor(BATCH_TRANSCRIPT_BYTES / Math.max(1, children.length)),
      );
      const multiChild = children.length > 1;
      const perChild = await Promise.all(
        children.map(async (child, index) => {
          const raw = await readChildTranscriptRaw(profileRoot, child, byteCap).catch(
            () => undefined,
          );
          if (raw === undefined || raw.contents.length === 0) return [];
          const launch = launches[index];
          // Prefix even a lone child, so its item ids hold when a sibling appears later.
          return transcriptToSubagentEntries(raw.contents, {
            prompt: launch?.prompt ?? input.launch.prompt,
            childPrefix: `${child.conversationId}:`,
            childLabel: multiChild ? launch?.role || child.conversationId : undefined,
            finalize: input.finalize,
          }).map((entry) => ({ ...entry, childKey: child.conversationId }));
        }),
      );
      if (!multiChild) return perChild.flat();
      // Undated entries inherit their child's previous timestamp so the comparator stays total.
      return perChild
        .flatMap((entries) => {
          let lastMs = 0;
          return entries.map((entry) => {
            lastMs =
              entry.createdAt === undefined ? lastMs : DateTime.toEpochMillis(entry.createdAt);
            return { entry, ms: lastMs };
          });
        })
        .map((keyed, position) => ({ ...keyed, position }))
        .sort((left, right) => left.ms - right.ms || left.position - right.position)
        .map(({ entry }) => entry);
    };
    return yield* Effect.tryPromise({
      try: read,
      catch: (cause) => new AntigravityChildWorkReadError({ cause }),
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<AcpSubagentTranscriptEntry> => []));
  },
);

/** Children a subagent tool call launched, proven by the parent's own session record. */
export const readAntigravityChildWork = Effect.fn("readAntigravityChildWork")(function* (input: {
  readonly profileDirectory: string;
  readonly rootSessionId: string;
  readonly nativeTaskId: string;
  readonly launch: BatchLaunch;
  /** The thread's other Antigravity batches from this instance. */
  readonly siblings: ReadonlyArray<BatchLaunch & { readonly nativeTaskId: string }>;
}) {
  if (!NATIVE_ID.test(input.rootSessionId)) return [];
  return yield* Effect.tryPromise({
    try: async (): Promise<ReadonlyArray<OrchestrationV2NativeChildWork>> => {
      const profileRoot = await antigravityProfileRoot(input.profileDirectory);
      if (profileRoot === undefined) return [];
      const record = await resolveAntigravityInvokeRecord(profileRoot, input);
      if (record === undefined) return [];
      const { launches, children } = record;
      // One budget for the whole batch, so the response stays small however many children ran.
      const byteCap = Math.min(
        TRANSCRIPT_BYTE_CAP,
        Math.floor(BATCH_TRANSCRIPT_BYTES / Math.max(1, children.length)),
      );
      return Promise.all(
        children.map(async (child, index) => {
          const transcript = await readChildTranscript(
            profileRoot,
            child,
            launches[index]?.prompt ?? "",
            byteCap,
          ).catch(() => undefined);
          return {
            conversationId: child.conversationId,
            role: launches[index]?.role ?? "",
            prompt: launches[index]?.prompt ?? "",
            steps: transcript?.steps ?? null,
            truncated: transcript?.truncated ?? false,
          };
        }),
      );
    },
    catch: (cause) => new AntigravityChildWorkReadError({ cause }),
  });
});

const decodeChildMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      sender: Schema.String,
      content: Schema.optional(Schema.String),
      sourceMetadata: Schema.optional(
        Schema.Struct({
          tool: Schema.optional(
            Schema.Struct({
              conversationId: Schema.optional(Schema.String),
              toolCall: Schema.optional(
                Schema.Struct({
                  id: Schema.String,
                  name: Schema.String,
                  argumentsJson: Schema.optional(Schema.String),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
);

const decodeDetachedSubagent = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      conversationId: Schema.optional(Schema.String),
      state: Schema.optional(Schema.String),
      subagentDescriptor: Schema.optional(
        Schema.Struct({
          role: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

/** A conversation's inbox. Throws past a bound or on a file it cannot read, so nothing is proven. */
async function readInbox(profileRoot: string, conversationId: string) {
  const directory = ["antigravity-acp", "brain", conversationId, ".system_generated", "messages"];
  const inbox = await antigravityManagedPath(profileRoot, directory, "directory");
  if (inbox === undefined) return [];
  // `read.json` is the runtime's read receipts, not a message.
  const names = (await NodeFSP.readdir(inbox.path)).filter(
    (name) => name.endsWith(".json") && name !== "read.json",
  );
  if (names.length > MAX_MESSAGE_FILES) throw new Error("Too many messages");
  return Promise.all(
    names.map(async (name) => {
      const file = await antigravityManagedPath(profileRoot, [...directory, name], "file");
      if (file === undefined || file.info.size > MAX_STEP_BYTES) throw new Error("Unreadable");
      return Option.getOrThrow(decodeChildMessage(await NodeFSP.readFile(file.path, "utf8")));
    }),
  );
}

type ChildMessage = Awaited<ReturnType<typeof readInbox>>[number];

async function listDetachedChildIds(
  profileRoot: string,
  rootSessionId: string,
): Promise<ReadonlyArray<string> | undefined> {
  const children = await antigravityManagedPath(
    profileRoot,
    ["antigravity-acp", "brain", rootSessionId, ".system_generated", "subagents"],
    "directory",
  );
  if (children === undefined) return undefined;
  const entries = await NodeFSP.readdir(children.path).catch(() => undefined);
  if (entries === undefined) return undefined;
  const childIds = entries.flatMap((name) =>
    name.endsWith(".json") && NATIVE_ID.test(name.slice(0, -5)) ? [name.slice(0, -5)] : [],
  );
  return childIds.length > MAX_DETACHED_CHILDREN ? undefined : childIds;
}

function detachedLaunchCall(message: ChildMessage, rootSessionId: string) {
  const tool = message.sourceMetadata?.tool;
  const call = tool?.toolCall;
  return message.sender === rootSessionId &&
    (tool?.conversationId === undefined || tool.conversationId === rootSessionId) &&
    (call?.name === "invoke_subagent" || call?.name === "swarm")
    ? call
    : undefined;
}

function swarmRoleLabel(descriptorRole: string | undefined): string | undefined {
  const trimmed = descriptorRole?.trim() ?? "";
  const match = /^Swarm Worker \((.+)\)$/.exec(trimmed);
  return match?.[1] !== undefined ? `@${match[1].trim()}` : undefined;
}

const decodeSwarmRoster = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      members: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            conversation_id: Schema.optional(Schema.String),
            role: Schema.optional(Schema.String),
            desired_state: Schema.optional(Schema.String),
            phase: Schema.optional(Schema.String),
            wake_mode: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  ),
);

interface DiskSwarmMember {
  readonly name: string;
  readonly role: string;
  readonly killed: boolean;
  readonly parked: boolean;
}

async function readDiskSwarmMembersByConversationId(
  profileRoot: string,
  rootSessionId: string,
): Promise<ReadonlyMap<string, DiskSwarmMember>> {
  const file = await antigravityManagedPath(
    profileRoot,
    ["antigravity-acp", "brain", rootSessionId, ".system_generated", "swarm", "members.json"],
    "file",
  );
  if (file === undefined || file.info.size > MAX_STEP_BYTES) return new Map();
  const raw = await NodeFSP.readFile(file.path, "utf8").catch(() => undefined);
  if (raw === undefined) return new Map();
  const decoded = Option.getOrUndefined(decodeSwarmRoster(raw));
  const members = decoded?.members;
  if (members === undefined) return new Map();
  const byConversation = new Map<string, DiskSwarmMember>();
  for (const [name, member] of Object.entries(members)) {
    const convId = member.conversation_id;
    if (convId === undefined || !NATIVE_ID.test(convId)) continue;
    const role = member.role ?? "worker";
    if (role === "coordinator") continue;
    const killed = member.desired_state === "KILLED" || member.phase === "KILLED";
    const parked = member.wake_mode === "mentions" || member.wake_mode === "anything";
    byConversation.set(convId, { name, role, killed, parked });
  }
  return byConversation;
}

async function readDetachedSubagent(profileRoot: string, rootSessionId: string, childId: string) {
  const file = await antigravityManagedPath(
    profileRoot,
    [
      "antigravity-acp",
      "brain",
      rootSessionId,
      ".system_generated",
      "subagents",
      `${childId}.json`,
    ],
    "file",
  );
  if (file === undefined || file.info.size > MAX_STEP_BYTES) return undefined;
  const contents = await NodeFSP.readFile(file.path, "utf8").catch(() => undefined);
  if (contents === undefined) return undefined;
  const record = Option.getOrUndefined(decodeDetachedSubagent(contents));
  return record !== undefined &&
    (record.conversationId === undefined || record.conversationId === childId)
    ? record
    : undefined;
}

/**
 * agy 1.5 records detached children under `subagents/` instead of a SQLite `INVOKE_SUBAGENT` step;
 * the child's own inbox carries the parent's launching `invoke_subagent` tool call id.
 */
async function findDetachedInvokeRecord(
  profileRoot: string,
  rootSessionId: string,
  nativeTaskId: string,
): Promise<InvokeRecord | undefined> {
  const childIds = await listDetachedChildIds(profileRoot, rootSessionId);
  if (childIds === undefined || childIds.length === 0) return undefined;
  const matches: Array<InvokeRecord & { readonly isSwarm: boolean }> = [];
  for (const childId of childIds) {
    const messages = await readInbox(profileRoot, childId).catch(() => undefined);
    // An unreadable or oversized sibling inbox could also claim this id, so uniqueness is unproven.
    if (messages === undefined) return undefined;
    const launchMessage = messages.find(
      (message) => detachedLaunchCall(message, rootSessionId)?.id === nativeTaskId,
    );
    if (launchMessage === undefined) continue;
    const subagent = await readDetachedSubagent(profileRoot, rootSessionId, childId);
    if (subagent === undefined) return undefined;
    const call = launchMessage.sourceMetadata?.tool?.toolCall;
    const isSwarm = call?.name === "swarm";
    const argumentsJson = call?.argumentsJson;
    const parsedArgs =
      argumentsJson === undefined
        ? undefined
        : Option.getOrUndefined(decodeArgument(argumentsJson));
    const argLaunches = antigravitySubagentLaunches(parsedArgs);
    const descriptorLabel = swarmRoleLabel(subagent.subagentDescriptor?.role);
    const matchedLaunch =
      isSwarm && descriptorLabel !== undefined
        ? (argLaunches?.find((entry) => entry.role.startsWith(descriptorLabel)) ?? {
            role: descriptorLabel,
            prompt: launchMessage.content ?? argLaunches?.[0]?.prompt ?? "",
          })
        : argLaunches?.[0];
    matches.push({
      isSwarm,
      toolCallId: nativeTaskId,
      launches: [
        matchedLaunch ?? {
          role: descriptorLabel ?? subagent.subagentDescriptor?.role ?? "",
          prompt: launchMessage.content ?? "",
        },
      ],
      children: [{ conversationId: childId }],
    });
  }
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1 && matches.every((entry) => entry.isSwarm)) {
    const ordered = [...matches].sort((left, right) =>
      (left.launches[0]?.role ?? "").localeCompare(right.launches[0]?.role ?? "", undefined, {
        numeric: true,
      }),
    );
    return {
      toolCallId: nativeTaskId,
      launches: ordered.flatMap((entry) => entry.launches),
      children: ordered.flatMap((entry) => entry.children),
    };
  }
  return undefined;
}

const PENDING_REPLY_TAIL_BYTES = 64 * 1024;
const HIGH_PRIORITY_MESSAGE = "MESSAGE_PRIORITY_HIGH";
const LOW_PRIORITY_MESSAGE = "MESSAGE_PRIORITY_LOW";

const decodeReadReceipts = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean)),
);

const decodeInboxPriorityMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      priority: Schema.optional(Schema.String),
    }),
  ),
);

async function hasUnreadWakingInboxMessage(
  profileRoot: string,
  sessionId: string,
): Promise<boolean> {
  const directory = ["antigravity-acp", "brain", sessionId, ".system_generated", "messages"];
  const inbox = await antigravityManagedPath(profileRoot, directory, "directory");
  if (inbox === undefined) return false;
  const entries = await NodeFSP.readdir(inbox.path).catch(() => undefined);
  if (entries === undefined) return false;
  const messageNames = entries.filter((name) => name.endsWith(".json") && name !== "read.json");
  if (messageNames.length === 0 || messageNames.length > MAX_MESSAGE_FILES) return false;
  let readReceipts: Readonly<Record<string, boolean>> = {};
  if (entries.includes("read.json")) {
    const receiptFile = await antigravityManagedPath(
      profileRoot,
      [...directory, "read.json"],
      "file",
    );
    if (receiptFile === undefined || receiptFile.info.size > MAX_STEP_BYTES) return false;
    const rawReceipts = await NodeFSP.readFile(receiptFile.path, "utf8").catch(() => undefined);
    if (rawReceipts === undefined) return false;
    const decodedReceipts = decodeReadReceipts(rawReceipts);
    if (Option.isNone(decodedReceipts)) return false;
    readReceipts = decodedReceipts.value;
  }
  for (const name of messageNames) {
    const fileId = name.slice(0, -5);
    if (readReceipts[fileId] === true) continue;
    const file = await antigravityManagedPath(profileRoot, [...directory, name], "file");
    if (file === undefined || file.info.size > MAX_STEP_BYTES) continue;
    const raw = await NodeFSP.readFile(file.path, "utf8").catch(() => undefined);
    if (raw === undefined) continue;
    const decoded = decodeInboxPriorityMessage(raw);
    if (Option.isNone(decoded)) continue;
    if (decoded.value.id !== undefined && readReceipts[decoded.value.id] === true) continue;
    if (decoded.value.priority === HIGH_PRIORITY_MESSAGE) return true;
  }
  return false;
}

async function readLastTranscriptLine(
  profileRoot: string,
  sessionId: string,
): Promise<Schema.Schema.Type<typeof TranscriptLine> | undefined> {
  const transcript = await antigravityManagedPath(
    profileRoot,
    ["antigravity-acp", "brain", sessionId, ".system_generated", "logs", "transcript.jsonl"],
    "file",
  );
  if (transcript === undefined) return undefined;
  const handle = await NodeFSP.open(
    transcript.path,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0) return undefined;
    for (const byteCap of [PENDING_REPLY_TAIL_BYTES, TRANSCRIPT_BYTE_CAP]) {
      const start = Math.max(0, stat.size - byteCap);
      const buffer = Buffer.alloc(stat.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let end = bytesRead;
      while (end > 0 && (buffer[end - 1] === 0x0a || buffer[end - 1] === 0x0d)) {
        end -= 1;
      }
      if (end === 0) {
        if (start === 0) return undefined;
        continue;
      }
      const trimmed = buffer.subarray(0, end);
      const lastNewline = trimmed.lastIndexOf(0x0a);
      if (lastNewline === -1 && start > 0) continue;
      const line = trimmed.toString("utf8", lastNewline + 1);
      return Option.getOrUndefined(decodeTranscriptLine(line));
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

/**
 * The model named on the latest `PLANNER_RESPONSE` since the last user prompt in the session's
 * `transcript.jsonl` tail. agy reports the model it ran only there, not over ACP.
 */
export const readAntigravityExecutedModel = Effect.fn("readAntigravityExecutedModel")(
  function* (input: { readonly profileDirectory: string; readonly sessionId: string }) {
    if (!NATIVE_ID.test(input.sessionId)) return undefined;
    const read = async (): Promise<string | undefined> => {
      const profileRoot = await antigravityProfileRoot(input.profileDirectory);
      if (profileRoot === undefined) return undefined;
      const transcript = await antigravityManagedPath(
        profileRoot,
        [
          "antigravity-acp",
          "brain",
          input.sessionId,
          ".system_generated",
          "logs",
          "transcript.jsonl",
        ],
        "file",
      );
      if (transcript === undefined) return undefined;
      const handle = await NodeFSP.open(
        transcript.path,
        NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return undefined;
        const start = Math.max(0, stat.size - TRANSCRIPT_BYTE_CAP);
        const buffer = Buffer.alloc(stat.size - start);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        const lines = buffer.toString("utf8", 0, bytesRead).split("\n");
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          const step = Option.getOrUndefined(decodeTranscriptLine(lines[index]!));
          if (step === undefined) continue;
          if (step.type === "USER_INPUT") return undefined;
          const model = step.type === "PLANNER_RESPONSE" ? step.model?.trim() : undefined;
          if (model) return model;
        }
        return undefined;
      } finally {
        await handle.close();
      }
    };
    return yield* Effect.tryPromise({
      try: read,
      catch: (cause) => new AntigravityChildWorkReadError({ cause }),
    }).pipe(Effect.orElseSucceed(() => undefined));
  },
);

/**
 * True when `agy` has a high-priority wake queued in the session's inbox or already dequeued as
 * the trailing `SYSTEM_MESSAGE` step in `transcript.jsonl` with no `PLANNER_RESPONSE` yet.
 * Fails closed when records are missing, linked, or unreadable.
 */
export const readAntigravityPendingReply = Effect.fn("readAntigravityPendingReply")(
  function* (input: { readonly profileDirectory: string; readonly sessionId: string }) {
    if (!NATIVE_ID.test(input.sessionId)) return false;
    const read = async (): Promise<boolean> => {
      const profileRoot = await antigravityProfileRoot(input.profileDirectory);
      if (profileRoot === undefined) return false;
      if (await hasUnreadWakingInboxMessage(profileRoot, input.sessionId)) return true;
      const lastStep = await readLastTranscriptLine(profileRoot, input.sessionId);
      if (lastStep === undefined || lastStep.type !== "SYSTEM_MESSAGE") return false;
      return (
        lastStep.content === undefined ||
        lastStep.content.includes(`priority=${HIGH_PRIORITY_MESSAGE}`) ||
        !lastStep.content.includes(`priority=${LOW_PRIORITY_MESSAGE}`)
      );
    };
    return yield* Effect.tryPromise({
      try: read,
      catch: (cause) => new AntigravityChildWorkReadError({ cause }),
    }).pipe(Effect.orElseSucceed(() => false));
  },
);

/**
 * agy 1.5 children outlive their `invoke_subagent` call and the agent reports no end for them:
 * a child is done, or waits for guidance, once its message is in the parent's inbox or its record
 * says it was killed. Returns the launching tool call ids of children with neither; none when the
 * records prove nothing.
 */
export const readAntigravityChildrenAtWork = Effect.fn("readAntigravityChildrenAtWork")(
  function* (input: {
    readonly profileDirectory: string;
    readonly rootSessionId: string;
    readonly toolCallIds: ReadonlyArray<string>;
  }) {
    if (!NATIVE_ID.test(input.rootSessionId)) return [];
    const read = async (): Promise<ReadonlyArray<string>> => {
      const profileRoot = await antigravityProfileRoot(input.profileDirectory);
      const childIds =
        profileRoot === undefined
          ? undefined
          : await listDetachedChildIds(profileRoot, input.rootSessionId);
      if (profileRoot === undefined || childIds === undefined) return [];
      const reported = new Set(
        (await readInbox(profileRoot, input.rootSessionId)).map((message) => message.sender),
      );
      const swarmMembers = await readDiskSwarmMembersByConversationId(
        profileRoot,
        input.rootSessionId,
      );
      const atWork = new Set<string>();
      for (const childId of childIds) {
        if (reported.has(childId)) continue;
        const swarmMember = swarmMembers.get(childId);
        if (swarmMember?.killed === true || swarmMember?.parked === true) continue;
        // `manage_subagents` kill only marks the record; a killed child never reports.
        const subagent = await readDetachedSubagent(profileRoot, input.rootSessionId, childId);
        if (subagent?.state === "SUBAGENT_STATE_KILLED") continue;
        const directTaskId = `swarm:${childId}`;
        if (input.toolCallIds.includes(directTaskId)) {
          atWork.add(directTaskId);
        }
        for (const message of await readInbox(profileRoot, childId)) {
          const launch = detachedLaunchCall(message, input.rootSessionId);
          if (launch !== undefined && input.toolCallIds.includes(launch.id)) {
            atWork.add(launch.id);
          }
        }
      }
      return [...atWork];
    };
    return yield* Effect.tryPromise({
      try: read,
      catch: (cause) => new AntigravityChildWorkReadError({ cause }),
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  },
);
