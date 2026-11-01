// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite reads the native session database read-only.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import type {
  OrchestrationV2NativeChildStep,
  OrchestrationV2NativeChildWork,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

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

interface AntigravityChildLaunch {
  readonly role: string;
  readonly prompt: string;
}

const decodeLaunchInput = Schema.decodeUnknownOption(
  Schema.Struct({
    Subagents: Schema.NonEmptyArray(Schema.Struct({ Role: Schema.String, Prompt: Schema.String })),
  }),
);

/** `invoke_subagent` arguments, from the permission prompt or the persisted record. */
export function antigravitySubagentLaunches(
  input: unknown,
): ReadonlyArray<AntigravityChildLaunch> | undefined {
  return Option.getOrUndefined(
    Option.map(decodeLaunchInput(input), (decoded) =>
      decoded.Subagents.map((entry) => ({ role: entry.Role, prompt: entry.Prompt })),
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

const textDecoder = new TextDecoder("utf-8", { fatal: true });
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

/**
 * Finds the parent record a subagent tool call created. Auto-approved calls carry
 * `<sessionId>:<plannerStep>`, and the record carrying that planner call's id is the proof.
 * Permission prompts carry a random id, so the launch text must match exactly one record
 * in a complete scan; an oversized, unreadable or over-budget table declines.
 */
function findInvokeRecord(
  database: NodeSqlite.DatabaseSync,
  input: {
    readonly rootSessionId: string;
    readonly nativeTaskId: string;
    readonly launch: { readonly title: string | null; readonly prompt: string };
  },
): InvokeRecord | undefined {
  const stepId = /^(.+):(\d+)$/.exec(input.nativeTaskId);
  if (stepId !== null) {
    if (stepId[1] !== input.rootSessionId) return undefined;
    const plannerIdx = Number(stepId[2]);
    const planner = payloadOf(
      database
        .prepare(
          "SELECT step_payload FROM steps WHERE idx = ? AND step_format = 0 AND length(step_payload) <= ?",
        )
        .get(plannerIdx, MAX_STEP_BYTES),
    );
    const callIds = (planner === undefined ? undefined : plannerInvokeCallIds(planner)) ?? [];
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
  if (
    total("rows") > MAX_INVOKE_ROWS ||
    total("bytes") > MAX_SCAN_BYTES ||
    total("largest") > MAX_STEP_BYTES ||
    total("other") > 0
  ) {
    return undefined;
  }
  const matches: Array<InvokeRecord> = [];
  for (const row of database
    .prepare("SELECT step_payload FROM steps WHERE step_type = ? ORDER BY idx")
    .iterate(INVOKE_SUBAGENT_STEP_TYPE)) {
    const payload = payloadOf(row);
    const record = payload === undefined ? undefined : decodeInvokeRecord(payload);
    // An unreadable record could be an identical launch, so uniqueness is unproven.
    if (record === undefined) return undefined;
    const described = describeAntigravitySubagentLaunches(record.launches);
    if (described.title === input.launch.title && described.prompt === input.launch.prompt) {
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
  readonly launch: { readonly title: string | null; readonly prompt: string };
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
