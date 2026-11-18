// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite reads the native session database read-only.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";

import type {
  OrchestrationV2NativeChildStep,
  OrchestrationV2NativeChildWork,
} from "@t3tools/contracts";
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
const STEP_RUN_COMMAND = 28;
const RUN_COMMAND_ID = 13;
const STEP_GENERIC = 140;
const STEP_TASK_DETAILS = 148;
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

/** T3's title for a batch whose launch text it never saw. */
export const ANTIGRAVITY_SUBAGENT_BATCH_TITLE = "Antigravity subagent batch";

interface AntigravityChildLaunch {
  readonly role: string;
  readonly prompt: string;
}

const SubagentLaunch = Schema.Struct({ Role: Schema.String, Prompt: Schema.String });
const decodeLaunchInput = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ Subagents: Schema.NonEmptyArray(SubagentLaunch) }),
    SubagentLaunch,
  ]),
);

/** `invoke_subagent` arguments, from the permission prompt or the persisted record. */
export function antigravitySubagentLaunches(
  input: unknown,
): ReadonlyArray<AntigravityChildLaunch> | undefined {
  return Option.getOrUndefined(
    Option.map(decodeLaunchInput(input), (decoded) =>
      ("Subagents" in decoded ? decoded.Subagents : [decoded]).map((entry) => ({
        role: entry.Role,
        prompt: entry.Prompt,
      })),
    ),
  );
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
function protoFields(bytes: Uint8Array): ReadonlyArray<readonly [number, Uint8Array]> {
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
  readonly children: ReadonlyArray<{ readonly conversationId: string; readonly logUri: string }>;
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

/** ACP omits native command/child IDs; the parent's persisted tool record owns that mapping. */
export const readAntigravityTaskIds = Effect.fn("readAntigravityTaskIds")(function* (
  profileDirectory: string,
  rootSessionId: string,
  tools: ReadonlyArray<{ readonly id: string; readonly input: unknown; readonly command: boolean }>,
  requestedIds: ReadonlyArray<string>,
) {
  if (!NATIVE_ID.test(rootSessionId)) return new Map<string, ReadonlyArray<string>>();
  return yield* Effect.tryPromise({
    try: async () => {
      const result = new Map<string, ReadonlyArray<string>>();
      const root = await antigravityProfileRoot(profileDirectory);
      if (root === undefined) return result;
      // The CLI's app-data-directory option selects either native session store.
      const file =
        (await antigravityManagedPath(
          root,
          ["antigravity-cli", "conversations", `${rootSessionId}.db`],
          "file",
        )) ??
        (await antigravityManagedPath(
          root,
          ["antigravity-acp", "conversations", `${rootSessionId}.db`],
          "file",
        ));
      if (file === undefined) return result;
      const database = new NodeSqlite.DatabaseSync(file.path, { readOnly: true });
      try {
        const owners = new Map(tools.map(({ id }) => [id, id]));
        for (const { id, input, command } of tools) {
          const step = /^(.*):(\d+)$/.exec(id);
          if (step?.[1] !== rootSessionId) continue;
          const payload = payloadOf(
            database
              .prepare(
                "SELECT step_payload FROM steps WHERE idx = ? AND step_format = 0 AND length(step_payload) <= ?",
              )
              .get(Number(step[2]), MAX_STEP_BYTES),
          );
          const calls =
            payload === undefined
              ? []
              : safely((bytes) =>
                  messages(
                    message(bytes, STEP_PLANNER_RESPONSE) ?? new Uint8Array(),
                    PLANNER_TOOL_CALLS,
                  ).map((call) => ({
                    id: text(call, 1),
                    name: text(call, 2),
                    args: text(call, 3),
                  })),
                )(payload);
          const candidates = calls?.filter((call) =>
            command
              ? call.name === "run_command"
              : call.name === "invoke_subagent" || call.name === "start_subagent",
          );
          const matches =
            candidates?.length === 1
              ? candidates
              : candidates?.filter(
                  (call) =>
                    call.args !== undefined &&
                    input !== undefined &&
                    Option.exists(decodeArgument(call.args), (args) =>
                      NodeUtil.isDeepStrictEqual(sanitizeAntigravityToolPayload(args), input),
                    ),
                );
          const match = matches?.length === 1 ? matches[0]?.id : undefined;
          owners.delete(id);
          if (match !== undefined && !owners.has(match)) owners.set(match, id);
        }
        if (owners.size === 0) return result;
        const byIndex = database.prepare(
          "SELECT idx, metadata FROM steps WHERE idx = ? AND step_format = 0 AND length(metadata) <= ?",
        );
        // Native command IDs encode their trajectory row; the payload still has to prove ownership.
        const indexed = requestedIds.flatMap((id) => {
          const step = /^(.+)\/task-(\d+)$/.exec(id);
          if (step?.[1] !== rootSessionId) return [];
          const idx = Number(step[2]);
          if (!Number.isSafeInteger(idx)) return [];
          const row = byIndex.get(idx, MAX_STEP_BYTES);
          return row === undefined ? [] : [row];
        });
        let metadataBytes = 0;
        let bytes = 0;
        let rows = 0;
        // Cortex step types: RUN_COMMAND=21, INVOKE_SUBAGENT=127, GENERIC=132 (exa.cortex_pb).
        const recent = database
          .prepare(
            "SELECT idx, CASE WHEN step_type IN (21, 127, 132) AND step_format = 0 AND length(metadata) <= ? THEN metadata END AS metadata FROM steps ORDER BY idx DESC LIMIT 2048",
          )
          .iterate(MAX_STEP_BYTES);
        function* candidates() {
          yield* indexed;
          yield* recent;
        }
        for (const row of candidates()) {
          const metadata = row.metadata;
          if (!(metadata instanceof Uint8Array)) continue;
          metadataBytes += metadata.length;
          if (metadataBytes > MAX_SCAN_BYTES) break;
          const callId = safely((data) => text(message(data, METADATA_TOOL_CALL), 1))(metadata);
          const owner = callId === undefined ? undefined : owners.get(callId);
          if (owner === undefined || result.has(owner)) continue;
          const payload = payloadOf(
            database
              .prepare("SELECT step_payload FROM steps WHERE idx = ? AND length(step_payload) <= ?")
              .get(row.idx!, MAX_STEP_BYTES),
          );
          if (payload === undefined) continue;
          bytes += payload.length;
          if (++rows > MAX_INVOKE_ROWS || bytes > MAX_SCAN_BYTES) break;
          const record = safely((data) => {
            const callId = text(message(message(data, STEP_METADATA), METADATA_TOOL_CALL), 1);
            const taskId = text(message(data, STEP_TASK_DETAILS), 1);
            const commandId = text(message(data, STEP_RUN_COMMAND), RUN_COMMAND_ID);
            const genericPayload = message(message(message(data, STEP_GENERIC), 2), 6);
            const genericChildren =
              text(genericPayload, 1) === "type.googleapis.com/exa.cortex.core.tools.InvokeSubagent"
                ? messages(message(genericPayload, 2) ?? new Uint8Array(), 2)
                : [];
            const children = messages(
              message(data, STEP_INVOKE_SUBAGENT) ?? new Uint8Array(),
              INVOKE_RESULTS,
            )
              .concat(genericChildren)
              .flatMap((child) => {
                const id = text(child, 1);
                return id === undefined ? [] : [id];
              });
            const id = taskId || commandId;
            return { callId, ids: children.length > 0 ? children : id ? [id] : [] };
          })(payload);
          if (
            record !== undefined &&
            record.callId === callId &&
            record.ids.length > 0 &&
            !result.has(owner)
          ) {
            result.set(owner, record.ids);
            if (result.size === owners.size) break;
          }
        }
        return result;
      } finally {
        database.close();
      }
    },
    catch: (cause) => new AntigravityChildWorkReadError({ cause }),
  });
});

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
  type: Schema.String,
  status: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  tool_calls: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, args: Schema.optional(Schema.Unknown) })),
  ),
});
const decodeTranscriptLine = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptLine));

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
  value.length <= limit ? value : `${value.slice(0, limit)}…`;

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
async function readChildTranscript(
  profileRoot: string,
  child: InvokeRecord["children"][number],
  prompt: string,
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
  let named: string;
  try {
    named = NodeURL.fileURLToPath(child.logUri);
  } catch {
    return undefined;
  }
  if ((await NodeFSP.realpath(named).catch(() => undefined)) !== expected) return undefined;
  const handle = await NodeFSP.open(
    expected,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    const length = Math.min(stat.size, byteCap);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
    const truncated = stat.size > length;
    let contents = buffer.subarray(0, bytesRead).toString("utf8");
    // A tail read starts mid-line.
    if (truncated) contents = contents.slice(contents.indexOf("\n") + 1);
    return { steps: transcriptSteps(contents, prompt), truncated };
  } finally {
    await handle.close();
  }
}

export function makeAntigravitySubagentStatusReader(profileDirectory: string, sessionId: string) {
  const children = new Map<string, ReadonlyArray<string>>();
  return Effect.fn("readAntigravitySubagentStatuses")(function* (
    tools: ReadonlyArray<AcpToolCallState>,
  ) {
    const missing = tools.filter((tool) => !children.has(tool.toolCallId));
    if (missing.length > 0) {
      const resolved = yield* readAntigravityTaskIds(
        profileDirectory,
        sessionId,
        missing.map((tool) => ({
          id: tool.toolCallId,
          input: tool.data.rawInput,
          command: false,
        })),
        [],
      );
      for (const tool of missing) {
        const ids = resolved.get(tool.toolCallId);
        if (ids && ids.length === antigravitySubagentLaunches(tool.data.rawInput)?.length) {
          children.set(tool.toolCallId, ids);
        }
      }
    }
    const result = new Map<string, "idle" | "running">();
    if (children.size === 0) return result;
    return yield* Effect.tryPromise({
      try: async () => {
        const root = await antigravityProfileRoot(profileDirectory);
        if (root === undefined) return result;
        for (const store of ["antigravity-cli", "antigravity-acp"]) {
          const file = await antigravityManagedPath(
            root,
            [store, "conversation_summaries.db"],
            "file",
          );
          if (file === undefined) continue;
          const db = new NodeSqlite.DatabaseSync(file.path, { readOnly: true });
          try {
            const query = db.prepare(
              "SELECT status FROM conversation_summaries WHERE conversation_id = ? AND parent_conversation_id = ?",
            );
            for (const tool of tools) {
              const ids = children.get(tool.toolCallId);
              if (!ids || result.has(tool.toolCallId)) continue;
              const states = ids.map((id) => query.get(id, sessionId)?.status);
              if (states.includes("CASCADE_RUN_STATUS_RUNNING"))
                result.set(tool.toolCallId, "running");
              else if (states.every((state) => state === "CASCADE_RUN_STATUS_IDLE"))
                result.set(tool.toolCallId, "idle");
            }
          } finally {
            db.close();
          }
        }
        return result;
      },
      catch: (cause) => new AntigravityChildWorkReadError({ cause }),
    });
  });
}

class AntigravityChildWorkReadError extends Schema.TaggedError<AntigravityChildWorkReadError>()(
  "AntigravityChildWorkReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read Antigravity subagent records.";
  }
}

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
      const databasePath =
        profileRoot === undefined
          ? undefined
          : (
              await antigravityManagedPath(
                profileRoot,
                ["antigravity-acp", "conversations", `${input.rootSessionId}.db`],
                "file",
              )
            )?.path;
      if (profileRoot === undefined || databasePath === undefined) return [];
      const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
      let record: InvokeRecord | undefined;
      try {
        record = findInvokeRecord(database, input);
      } finally {
        database.close();
      }
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
