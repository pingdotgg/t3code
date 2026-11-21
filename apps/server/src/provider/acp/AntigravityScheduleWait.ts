// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite reads the native session database read-only.
import * as NodeSqlite from "node:sqlite";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { protoFields } from "./AntigravityChildWork.ts";
import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

// CORTEX_STEP_TYPE_GENERIC and CORTEX_STEP_STATUS_RUNNING in exa.cortex_pb.
const GENERIC_STEP_TYPE = 132;
const RUNNING_STEP_STATUS = 2;
// Field numbers in exa.cortex_pb.CortexStep / CortexStepMetadata / ToolCall / TaskDetails.
const STEP_METADATA = 5;
const METADATA_CREATED_AT = 1;
const METADATA_TOOL_CALL = 4;
const TOOL_CALL_NAME = 2;
const TOOL_CALL_ARGS_JSON = 3;
const TOOL_CALL_CANONICAL_NAME = 9;
const STEP_TASK_DETAILS = 148;
const TASK_DETAILS_STARTED_AT = 8;

// Allow wake latency after the scheduled deadline before resuming inactivity detection.
const SCHEDULE_EXPIRY_GRACE_MILLIS = 60_000;
const SCHEDULE_PAGE_SIZE = 32;
const MAX_SCHEDULE_SCAN_ROWS = 512;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const SCHEDULE_MARKER = new TextEncoder().encode("schedule");
const NATIVE_SESSION_ID = /^[\w-]{1,64}$/;
const CONVERSATION_SEGMENTS = ["antigravity-acp", "conversations"] as const;

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const fieldBytes = (bytes: Uint8Array | undefined, fieldNumber: number): Uint8Array | undefined => {
  if (bytes === undefined) return undefined;
  for (const [number, value] of protoFields(bytes)) {
    if (number === fieldNumber) return value;
  }
  return undefined;
};

const fieldText = (bytes: Uint8Array | undefined, fieldNumber: number): string | undefined => {
  const value = fieldBytes(bytes, fieldNumber);
  return value === undefined ? undefined : textDecoder.decode(value);
};

/** Decodes google.protobuf.Timestamp (`1: int64 seconds`, `2: int32 nanos`) to epoch millis. */
function decodeProtoTimestampMillis(bytes: Uint8Array | undefined): number | undefined {
  if (bytes === undefined || bytes.length === 0) return undefined;
  let offset = 0;
  let seconds: number | undefined;
  let nanos = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = bytes[offset++];
      if (byte === undefined) return undefined;
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    return undefined;
  };
  while (offset < bytes.length) {
    const key = varint();
    if (key === undefined) return undefined;
    const wire = key % 8;
    const field = Math.floor(key / 8);
    if (wire === 0) {
      const value = varint();
      if (value === undefined) return undefined;
      if (field === 1) seconds = value;
      else if (field === 2) nanos = value;
    } else if (wire === 1) {
      offset += 8;
    } else if (wire === 5) {
      offset += 4;
    } else if (wire === 2) {
      const length = varint();
      if (length === undefined || offset + length > bytes.length) return undefined;
      offset += length;
    } else {
      return undefined;
    }
  }
  if (offset !== bytes.length || seconds === undefined || seconds <= 0) return undefined;
  return seconds * 1_000 + Math.floor(nanos / 1_000_000);
}

const ScheduleArgs = Schema.Struct({
  DurationSeconds: Schema.optional(Schema.Number),
  IsDaemon: Schema.optional(Schema.Boolean),
});
const decodeScheduleArgsJson = Schema.decodeUnknownOption(Schema.fromJsonString(ScheduleArgs));

function isUnexpiredScheduleStep(
  row: {
    readonly metadata: Uint8Array | null;
    readonly taskDetails: Uint8Array | null;
    readonly payload: Uint8Array | null;
  },
  nowMillis: number,
): boolean {
  try {
    const metaBytes =
      row.metadata ?? (row.payload === null ? undefined : fieldBytes(row.payload, STEP_METADATA));
    const toolCall = fieldBytes(metaBytes, METADATA_TOOL_CALL);
    const toolName =
      fieldText(toolCall, TOOL_CALL_NAME) ?? fieldText(toolCall, TOOL_CALL_CANONICAL_NAME);
    if (toolName !== "schedule") return false;
    const argsJson = fieldText(toolCall, TOOL_CALL_ARGS_JSON);
    if (argsJson === undefined) return false;
    const args = Option.getOrUndefined(decodeScheduleArgsJson(argsJson));
    if (args === undefined || args.IsDaemon === true) return false;
    const durationSeconds = args.DurationSeconds;
    if (
      durationSeconds === undefined ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0
    ) {
      return false;
    }
    const taskDetailsBytes =
      row.taskDetails ??
      (row.payload === null ? undefined : fieldBytes(row.payload, STEP_TASK_DETAILS));
    const startedAtMillis =
      decodeProtoTimestampMillis(fieldBytes(taskDetailsBytes, TASK_DETAILS_STARTED_AT)) ??
      decodeProtoTimestampMillis(fieldBytes(metaBytes, METADATA_CREATED_AT));
    if (startedAtMillis === undefined) return false;
    return nowMillis < startedAtMillis + durationSeconds * 1_000 + SCHEDULE_EXPIRY_GRACE_MILLIS;
  } catch {
    return false;
  }
}

class AntigravityScheduleWaitReadError extends Schema.TaggedError<AntigravityScheduleWaitReadError>()(
  "AntigravityScheduleWaitReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read scheduled timers from the Antigravity session database.";
  }
}

/**
 * Antigravity holds `session/prompt` open during native `schedule` timers without emitting ACP
 * tool calls. Returns `true` only while an unexpired one-shot timer is running in the session db.
 */
export const hasLiveAntigravityScheduleTimer = Effect.fn("hasLiveAntigravityScheduleTimer")(
  function* (input: { readonly profileDirectory: string; readonly sessionId: string }) {
    if (!NATIVE_SESSION_ID.test(input.sessionId)) return false;
    const nowMillis = yield* Clock.currentTimeMillis;
    const read = async (): Promise<boolean> => {
      const profileRoot = await antigravityProfileRoot(input.profileDirectory);
      if (profileRoot === undefined) return false;
      const databaseFile = await antigravityManagedPath(
        profileRoot,
        [...CONVERSATION_SEGMENTS, `${input.sessionId}.db`],
        "file",
      );
      if (databaseFile === undefined) return false;
      const database = new NodeSqlite.DatabaseSync(databaseFile.path, { readOnly: true });
      try {
        database.exec("PRAGMA busy_timeout = 100");
        const hasSteps =
          database
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'")
            .get() !== undefined;
        if (!hasSteps) return false;
        const page = database.prepare(
          `SELECT idx, metadata, task_details AS taskDetails, substr(step_payload, 1, ?) AS payload
           FROM steps
           WHERE step_type = ? AND status = ? AND (? IS NULL OR idx < ?)
             AND (instr(metadata, ?) > 0 OR instr(substr(step_payload, 1, ?), ?) > 0)
           ORDER BY idx DESC
           LIMIT ?`,
        );
        let beforeIdx: number | null = null;
        let scannedRows = 0;
        let scannedBytes = 0;
        while (scannedRows < MAX_SCHEDULE_SCAN_ROWS && scannedBytes < MAX_SCAN_BYTES) {
          const cursor: number | null = beforeIdx;
          const rows: ReadonlyArray<Record<string, NodeSqlite.SQLOutputValue>> = page.all(
            MAX_PAYLOAD_BYTES,
            GENERIC_STEP_TYPE,
            RUNNING_STEP_STATUS,
            cursor,
            cursor,
            SCHEDULE_MARKER,
            MAX_PAYLOAD_BYTES,
            SCHEDULE_MARKER,
            SCHEDULE_PAGE_SIZE,
          );
          if (rows.length === 0) return false;
          for (const row of rows) {
            if (typeof row.idx !== "number") return false;
            beforeIdx = row.idx;
            scannedRows += 1;
            const metadata =
              row.metadata instanceof Uint8Array
                ? row.metadata.subarray(0, MAX_METADATA_BYTES)
                : null;
            const taskDetails =
              row.taskDetails instanceof Uint8Array
                ? row.taskDetails.subarray(0, MAX_METADATA_BYTES)
                : null;
            const payload = row.payload instanceof Uint8Array ? row.payload : null;
            scannedBytes +=
              (metadata?.byteLength ?? 0) +
              (taskDetails?.byteLength ?? 0) +
              (payload?.byteLength ?? 0);
            if (isUnexpiredScheduleStep({ metadata, taskDetails, payload }, nowMillis)) {
              return true;
            }
            if (scannedRows >= MAX_SCHEDULE_SCAN_ROWS || scannedBytes >= MAX_SCAN_BYTES) {
              return false;
            }
          }
          if (rows.length < SCHEDULE_PAGE_SIZE) return false;
        }
        return false;
      } finally {
        database.close();
      }
    };
    return yield* Effect.tryPromise({
      try: read,
      catch: (cause) => new AntigravityScheduleWaitReadError({ cause }),
    }).pipe(Effect.orElseSucceed(() => false));
  },
);
