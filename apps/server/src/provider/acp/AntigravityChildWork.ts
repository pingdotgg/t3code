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
import { boundAntigravityToolText, isCutAntigravityToolText } from "./AntigravityProtocol.ts";

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
// agy 1.5 launches one child per call with a flat input; earlier releases send a batch.
const decodeLaunchInput = Schema.decodeUnknownOption(
  Schema.Union([Schema.Struct({ Subagents: Schema.NonEmptyArray(LaunchInput) }), LaunchInput]),
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
      if (newline === -1) return { steps: [], truncated: true };
      lineStart = newline + 1;
    }
    const contents = bytes.toString("utf8", lineStart);
    return { steps: transcriptSteps(contents, prompt), truncated: tailStart > 0 };
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
  readonly launch: BatchLaunch;
  /** The thread's other Antigravity batches from this instance. */
  readonly siblings: ReadonlyArray<BatchLaunch & { readonly nativeTaskId: string }>;
}) {
  if (!NATIVE_ID.test(input.rootSessionId)) return [];
  return yield* Effect.tryPromise({
    try: async (): Promise<ReadonlyArray<OrchestrationV2NativeChildWork>> => {
      const profileRoot = await antigravityProfileRoot(input.profileDirectory);
      if (profileRoot === undefined) return [];
      let record = await findDetachedInvokeRecord(
        profileRoot,
        input.rootSessionId,
        input.nativeTaskId,
      );
      if (record === undefined) {
        const databasePath = (
          await antigravityManagedPath(
            profileRoot,
            ["antigravity-acp", "conversations", `${input.rootSessionId}.db`],
            "file",
          )
        )?.path;
        if (databasePath === undefined) return [];
        const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
        try {
          record = findInvokeRecord(database, input);
        } finally {
          database.close();
        }
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
    call?.name === "invoke_subagent"
    ? call
    : undefined;
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
  const matches: Array<InvokeRecord> = [];
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
    const argumentsJson = launchMessage.sourceMetadata?.tool?.toolCall?.argumentsJson;
    const parsedArgs =
      argumentsJson === undefined
        ? undefined
        : Option.getOrUndefined(decodeArgument(argumentsJson));
    const [fromArgs] = antigravitySubagentLaunches(parsedArgs) ?? [];
    matches.push({
      toolCallId: nativeTaskId,
      launches: [
        fromArgs ?? {
          role: subagent.subagentDescriptor?.role ?? "",
          prompt: launchMessage.content ?? "",
        },
      ],
      children: [{ conversationId: childId }],
    });
  }
  const [match] = matches;
  return matches.length === 1 ? match : undefined;
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
      const atWork: Array<string> = [];
      for (const childId of childIds) {
        if (reported.has(childId)) continue;
        // `manage_subagents` kill only marks the record; a killed child never reports.
        const subagent = await readDetachedSubagent(profileRoot, input.rootSessionId, childId);
        if (subagent?.state === "SUBAGENT_STATE_KILLED") continue;
        for (const message of await readInbox(profileRoot, childId)) {
          const launch = detachedLaunchCall(message, input.rootSessionId);
          if (launch !== undefined && input.toolCallIds.includes(launch.id)) {
            atWork.push(launch.id);
          }
        }
      }
      return atWork;
    };
    return yield* Effect.tryPromise({
      try: read,
      catch: (cause) => new AntigravityChildWorkReadError({ cause }),
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  },
);
