// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite and O_NOFOLLOW read Antigravity's native session records safely.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { protoFields } from "./AntigravityChildWork.ts";
import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";
import { boundAntigravityToolText } from "./AntigravityProtocol.ts";

// Field numbers from the runtime's trajectory protos (exa.cortex_pb).
const STEP_METADATA = 5;
const METADATA_TOOL_CALL = 4;
const RUN_COMMAND_STEP_TYPE = 132;

const ANTIGRAVITY_TASK_OUTPUT_POLL_MS = 250;
// Covers WaitMsBeforeAsync (up to 10s) plus startup jitter before task-<idx>.log appears.
const MAX_LOCATE_ATTEMPTS = 120;
const MAX_READ_BYTES = 256 * 1024;
const MAX_STEP_BYTES = 1024 * 1024;
const MAX_COMMAND_ROWS = 400;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

const NATIVE_ID = /^[A-Za-z0-9-]{1,64}$/;
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const CommandToolArguments = Schema.Struct({
  toolSummary: Schema.optional(Schema.String),
  tool_summary: Schema.optional(Schema.String),
});
const decodeCommandToolArguments = Schema.decodeUnknownOption(
  Schema.fromJsonString(CommandToolArguments),
);

interface AntigravityCommandStep {
  readonly stepIdx: number;
  readonly toolSummary: string | undefined;
}

const fieldBytes = (bytes: Uint8Array | undefined, field: number): Uint8Array | undefined => {
  if (bytes === undefined) return undefined;
  for (const [number, value] of protoFields(bytes)) {
    if (number === field) return value;
  }
  return undefined;
};

const fieldText = (bytes: Uint8Array | undefined, field: number): string | undefined => {
  const value = fieldBytes(bytes, field);
  return value === undefined ? undefined : textDecoder.decode(value);
};

function decodeCommandToolCall(
  payload: Uint8Array,
): { readonly toolCallId: string; readonly toolSummary: string | undefined } | undefined {
  try {
    const toolCall = fieldBytes(fieldBytes(payload, STEP_METADATA), METADATA_TOOL_CALL);
    const toolCallId = fieldText(toolCall, 1);
    if (!toolCallId) return undefined;
    const argsJson = fieldText(toolCall, 3);
    const args =
      argsJson === undefined
        ? undefined
        : Option.getOrUndefined(decodeCommandToolArguments(argsJson));
    const rawSummary = (args?.toolSummary ?? args?.tool_summary)?.trim();
    const toolSummary = rawSummary ? boundAntigravityToolText(rawSummary) : undefined;
    return { toolCallId, toolSummary };
  } catch {
    return undefined;
  }
}

async function findCommandStep(
  profileRoot: string,
  sessionId: string,
  toolCallId: string,
): Promise<AntigravityCommandStep | undefined> {
  const databasePath = (
    await antigravityManagedPath(
      profileRoot,
      ["antigravity-acp", "conversations", `${sessionId}.db`],
      "file",
    )
  )?.path;
  if (databasePath === undefined) return undefined;
  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  } catch {
    return undefined;
  }
  try {
    let rows = 0;
    let bytes = 0;
    for (const row of database
      .prepare(
        "SELECT idx, length(step_payload) AS size, CASE WHEN length(step_payload) <= ? THEN step_payload END AS step_payload FROM steps WHERE step_type = ? AND step_format = 0 ORDER BY idx DESC",
      )
      .iterate(MAX_STEP_BYTES, RUN_COMMAND_STEP_TYPE)) {
      if (row === null || typeof row !== "object") continue;
      const size = "size" in row ? Number(row.size) : 0;
      rows += 1;
      bytes += size;
      if (rows > MAX_COMMAND_ROWS || size > MAX_STEP_BYTES || bytes > MAX_SCAN_BYTES) {
        return undefined;
      }
      const payload =
        "step_payload" in row && row.step_payload instanceof Uint8Array
          ? row.step_payload
          : undefined;
      if (payload === undefined) continue;
      const decoded = decodeCommandToolCall(payload);
      if (decoded === undefined || decoded.toolCallId !== toolCallId) continue;
      const stepIdx = "idx" in row ? Number(row.idx) : Number.NaN;
      if (!Number.isInteger(stepIdx) || stepIdx < 0) return undefined;
      return { stepIdx, toolSummary: decoded.toolSummary };
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    database.close();
  }
}

async function readTaskLogSlice(
  logPath: string,
  offset: number,
): Promise<
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "chunk";
      readonly bytes: Uint8Array;
      readonly nextOffset: number;
      readonly reset: boolean;
      readonly skipped: boolean;
    }
> {
  const handle = await NodeFSP.open(
    logPath,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { kind: "unchanged" };
    const size = stat.size;
    const reset = size < offset;
    const effectiveOffset = reset ? 0 : offset;
    if (size <= effectiveOffset) {
      return reset
        ? { kind: "chunk", bytes: new Uint8Array(0), nextOffset: 0, reset: true, skipped: false }
        : { kind: "unchanged" };
    }
    const start = size - effectiveOffset > MAX_READ_BYTES ? size - MAX_READ_BYTES : effectiveOffset;
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return {
      kind: "chunk",
      bytes: buffer.subarray(0, bytesRead),
      nextOffset: start + bytesRead,
      reset,
      skipped: start > effectiveOffset,
    };
  } finally {
    await handle.close();
  }
}

class AntigravityTaskOutputReadError extends Schema.TaggedError<AntigravityTaskOutputReadError>()(
  "AntigravityTaskOutputReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read Antigravity task output.";
  }
}

const tryRead = <A>(read: () => Promise<A>, fallback: A) =>
  Effect.tryPromise({
    try: read,
    catch: (cause) => new AntigravityTaskOutputReadError({ cause }),
  }).pipe(Effect.orElseSucceed(() => fallback));

/**
 * Antigravity streams background `run_command` output to `brain/<sessionId>/.system_generated/tasks/task-<idx>.log`
 * without sending ACP terminal chunks, and may strip `toolSummary` from the wire payload.
 * Complete `stop` on command completion or turn end, then await the fiber for a final read.
 */
export const tailAntigravityCommandOutput = Effect.fn("AntigravityTaskOutputTail.tail")(
  function* (input: {
    readonly profileDirectory: string;
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly stop: Deferred.Deferred<void>;
    readonly onChunk: (chunk: string) => Effect.Effect<void>;
    readonly onTitle?: (title: string) => Effect.Effect<void>;
  }) {
    if (!NATIVE_ID.test(input.sessionId) || input.toolCallId.trim().length === 0) return;
    const pause = Deferred.await(input.stop).pipe(
      Effect.as(true),
      Effect.timeoutOrElse({
        duration: ANTIGRAVITY_TASK_OUTPUT_POLL_MS,
        orElse: () => Effect.succeed(false),
      }),
    );
    const profileRoot = yield* tryRead(
      () => antigravityProfileRoot(input.profileDirectory),
      undefined,
    );
    if (profileRoot === undefined) return;

    let step: AntigravityCommandStep | undefined;
    let titleReported = false;
    let logPath: string | undefined;
    let stopped = yield* Deferred.isDone(input.stop);

    for (let attempt = 0; logPath === undefined; attempt += 1) {
      if (step === undefined) {
        step = yield* tryRead(
          () => findCommandStep(profileRoot, input.sessionId, input.toolCallId),
          undefined,
        );
        if (step?.toolSummary !== undefined && !titleReported && input.onTitle !== undefined) {
          titleReported = true;
          yield* input.onTitle(step.toolSummary);
        }
      }
      if (step !== undefined) {
        const stepIdx = step.stepIdx;
        logPath = yield* tryRead(
          async () =>
            (
              await antigravityManagedPath(
                profileRoot,
                [
                  "antigravity-acp",
                  "brain",
                  input.sessionId,
                  ".system_generated",
                  "tasks",
                  `task-${stepIdx}.log`,
                ],
                "file",
              )
            )?.path,
          undefined,
        );
        if (logPath !== undefined) break;
      }
      if (stopped || attempt + 1 >= MAX_LOCATE_ATTEMPTS) return;
      stopped = yield* pause;
    }

    let decoder = new TextDecoder("utf-8", { fatal: false });
    let offset = 0;
    let last = yield* Deferred.isDone(input.stop);
    while (true) {
      const slice = yield* tryRead(() => readTaskLogSlice(logPath, offset), {
        kind: "unchanged" as const,
      });
      if (slice.kind === "chunk") {
        if (slice.reset) {
          decoder = new TextDecoder("utf-8", { fatal: false });
        }
        let first = 0;
        if (slice.skipped) {
          decoder = new TextDecoder("utf-8", { fatal: false });
          while (((slice.bytes[first] ?? 0) & 0xc0) === 0x80) first += 1;
        }
        offset = slice.nextOffset;
        const text =
          (slice.skipped ? "\n" : "") +
          decoder.decode(slice.bytes.subarray(first), { stream: true });
        if (text.length > 0) yield* input.onChunk(text);
      }
      if (last) {
        const rest = decoder.decode();
        if (rest.length > 0) yield* input.onChunk(rest);
        return;
      }
      last = yield* pause;
    }
  },
);
