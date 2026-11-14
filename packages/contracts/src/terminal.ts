import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const DEFAULT_TERMINAL_ID = "term-1";
export const DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024;

const historyEncoder = new TextEncoder();
// A BOM at a retained chunk boundary is terminal data, not an encoding marker.
const historyDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

// libghostty-vt's parser states, merged where the same input takes them back to ground.
export const TERMINAL_SEQUENCE_GROUND = 0;
const SEQUENCE_ESCAPE = 1;
const SEQUENCE_ESCAPE_INTERMEDIATE = 2;
const SEQUENCE_CSI = 3;
const SEQUENCE_DCS = 4;
const SEQUENCE_SOS_PM_APC = 5;
const SEQUENCE_OSC = 6;

// Bits above the low three hold a high surrogate until its other half arrives.
function nextTerminalSequenceState(state: number, unit: number): number {
  if (unit === 0x1b) return SEQUENCE_ESCAPE;
  if (state === TERMINAL_SEQUENCE_GROUND || unit === 0x18 || unit === 0x1a) {
    return TERMINAL_SEQUENCE_GROUND;
  }
  let mode = state & 7;
  if (unit < 0x80) {
    switch (mode) {
      case SEQUENCE_ESCAPE:
        if (unit < 0x20 || unit === 0x7f) return mode;
        if (unit < 0x30) return SEQUENCE_ESCAPE_INTERMEDIATE;
        if (unit === 0x5b) return SEQUENCE_CSI;
        if (unit === 0x5d) return SEQUENCE_OSC;
        if (unit === 0x50) return SEQUENCE_DCS;
        return unit === 0x58 || unit === 0x5e || unit === 0x5f
          ? SEQUENCE_SOS_PM_APC
          : TERMINAL_SEQUENCE_GROUND;
      case SEQUENCE_ESCAPE_INTERMEDIATE:
        return unit >= 0x30 && unit !== 0x7f ? TERMINAL_SEQUENCE_GROUND : mode;
      case SEQUENCE_CSI:
        return unit >= 0x40 && unit !== 0x7f ? TERMINAL_SEQUENCE_GROUND : mode;
      case SEQUENCE_OSC:
        return unit === 0x07 ? TERMINAL_SEQUENCE_GROUND : mode;
      default:
        return mode;
    }
  }
  if (mode === SEQUENCE_OSC) return mode;
  if (unit >= 0xd800 && unit <= 0xdbff) return mode | (unit << 3);
  let codePoint = unit;
  if (unit >= 0xdc00 && unit <= 0xdfff) {
    if (state < 8) return mode;
    codePoint = 0x10000 + (((state >> 3) - 0xd800) << 10) + (unit - 0xdc00);
  }
  // Outside ground and OSC the parser reads UTF-8 bytes one at a time, so a continuation
  // byte in 0x80-0x9F acts as a C1 control: most end the sequence, five start another.
  for (let shift = codePoint > 0xffff ? 12 : codePoint > 0x7ff ? 6 : 0; shift >= 0; shift -= 6) {
    const byte = 0x80 | ((codePoint >> shift) & 0x3f);
    if (byte >= 0xa0) continue;
    if (byte === 0x9d) return SEQUENCE_OSC;
    if (byte === 0x90) mode = SEQUENCE_DCS;
    else if (byte === 0x9b) mode = SEQUENCE_CSI;
    else if (byte === 0x98 || byte >= 0x9e) mode = SEQUENCE_SOS_PM_APC;
    else return TERMINAL_SEQUENCE_GROUND;
  }
  return mode;
}

/** The parser state after `text.slice(start, end)`, for a terminal that entered it in `state`. */
export function terminalSequenceStateAfter(
  state: number,
  text: string,
  start = 0,
  end = text.length,
): number {
  if (end <= start) return state;
  // ESC enters the escape state from every state, so only what follows the last one matters.
  const escape = text.lastIndexOf("\u001b", end - 1);
  if (escape >= start) {
    state = SEQUENCE_ESCAPE;
    start = escape + 1;
  }
  for (let index = start; index < end && state !== TERMINAL_SEQUENCE_GROUND; index += 1) {
    state = nextTerminalSequenceState(state, text.charCodeAt(index));
  }
  return state;
}

/** Where in `text` a terminal that entered it in `state` is first back in ground state. */
export function terminalSequenceEnd(state: number, text: string): number {
  let index = 0;
  while (state !== TERMINAL_SEQUENCE_GROUND && index < text.length) {
    state = nextTerminalSequenceState(state, text.charCodeAt(index));
    index += 1;
  }
  return index;
}

/**
 * The final `maxBytes` of UTF-8 a client retains, starting at a code point boundary and
 * outside any control sequence the cut went through.
 */
export function retainedTerminalHistory(history: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  const encoded = historyEncoder.encode(history);
  if (encoded.byteLength <= maxBytes) {
    return history;
  }

  let start = encoded.byteLength - maxBytes;
  while (start < encoded.length) {
    const byte = encoded[start];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    start += 1;
  }

  const retained = historyDecoder.decode(encoded.subarray(start));
  const state = terminalSequenceStateAfter(
    TERMINAL_SEQUENCE_GROUND,
    history,
    0,
    history.length - retained.length,
  );
  return retained.slice(terminalSequenceEnd(state, retained));
}

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const TerminalColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(1000),
);
const TerminalRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(500),
);
const TerminalIdSchema = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(128));
const TerminalEnvKeySchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
).check(Schema.isMaxLength(128));
const TerminalEnvValueSchema = Schema.String.check(Schema.isMaxLength(8_192));
const TerminalEnvSchema = Schema.Record(TerminalEnvKeySchema, TerminalEnvValueSchema).check(
  Schema.isMaxProperties(128),
);

export const TerminalThreadInput = Schema.Struct({
  threadId: TrimmedNonEmptyStringSchema,
});
export type TerminalThreadInput = typeof TerminalThreadInput.Type;

// Terminal ids are client-chosen; the server never allocates them.
const TerminalSessionInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: TerminalIdSchema,
});
export type TerminalSessionInput = Schema.Codec.Encoded<typeof TerminalSessionInput>;

export const TerminalOpenInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
  env: Schema.optional(TerminalEnvSchema),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  stopOnSettle: Schema.optional(Schema.Boolean),
});
export type TerminalOpenInput = typeof TerminalOpenInput.Type;

export const TerminalAttachInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: Schema.optional(TrimmedNonEmptyStringSchema),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
  env: Schema.optional(TerminalEnvSchema),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  stopOnSettle: Schema.optional(Schema.Boolean),
  restartIfNotRunning: Schema.optional(Schema.Boolean),
  // Resubscriptions preserve stopped terminals; unknown IDs recover after a server restart.
  resume: Schema.optional(Schema.Boolean),
  // Snapshots carry only the history a client this bounded keeps; older servers ignore it.
  maxHistoryBytes: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type TerminalAttachInput = typeof TerminalAttachInput.Type;

export const TerminalObserveInput = TerminalSessionInput;
export type TerminalObserveInput = Schema.Codec.Encoded<typeof TerminalObserveInput>;

export const TerminalWriteInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
});
export type TerminalWriteInput = Schema.Codec.Encoded<typeof TerminalWriteInput>;

export const TerminalResizeInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
});
export type TerminalResizeInput = Schema.Codec.Encoded<typeof TerminalResizeInput>;

export const TerminalClearInput = TerminalSessionInput;
export type TerminalClearInput = Schema.Codec.Encoded<typeof TerminalClearInput>;

export const TerminalCloseInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: Schema.optional(TerminalIdSchema),
  deleteHistory: Schema.optional(Schema.Boolean),
});
export type TerminalCloseInput = typeof TerminalCloseInput.Type;

export const TerminalSessionStatus = Schema.Literals(["starting", "running", "exited", "error"]);
export type TerminalSessionStatus = typeof TerminalSessionStatus.Type;

export const TerminalSessionSnapshot = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  cwd: Schema.String.check(Schema.isNonEmpty()),
  worktreePath: Schema.NullOr(TrimmedNonEmptyStringSchema),
  status: TerminalSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  history: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  label: Schema.String.check(Schema.isMaxLength(128)),
  updatedAt: Schema.String,
  sequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  // The PTY grid every renderer of this terminal should draw; absent from older servers.
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
});
export type TerminalSessionSnapshot = typeof TerminalSessionSnapshot.Type;

export const TerminalSummary = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  cwd: Schema.String.check(Schema.isNonEmpty()),
  worktreePath: Schema.NullOr(TrimmedNonEmptyStringSchema),
  status: TerminalSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  hasRunningSubprocess: Schema.Boolean,
  label: Schema.String.check(Schema.isMaxLength(128)),
  updatedAt: Schema.String,
});
export type TerminalSummary = typeof TerminalSummary.Type;

const TerminalMetadataSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  terminals: Schema.Array(TerminalSummary),
});

const TerminalMetadataUpsertEvent = Schema.Struct({
  type: Schema.Literal("upsert"),
  terminal: TerminalSummary,
});

const TerminalMetadataRemoveEvent = Schema.Struct({
  type: Schema.Literal("remove"),
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
});

export const TerminalMetadataStreamEvent = Schema.Union([
  TerminalMetadataSnapshotEvent,
  TerminalMetadataUpsertEvent,
  TerminalMetadataRemoveEvent,
]);
export type TerminalMetadataStreamEvent = typeof TerminalMetadataStreamEvent.Type;

const TerminalEventBaseSchema = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  sequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

const TerminalStartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("started"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalOutputEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("output"),
  data: Schema.String,
});

const TerminalExitedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("exited"),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});

const TerminalClosedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("closed"),
});

const TerminalErrorEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("error"),
  message: Schema.String.check(Schema.isNonEmpty()),
});

const TerminalClearedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("cleared"),
});

const TerminalRestartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("restarted"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalActivityEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("activity"),
  hasRunningSubprocess: Schema.Boolean,
  label: Schema.String.check(Schema.isMaxLength(128)),
  // Shared PTY grid changes ride on activity because older clients reject unknown event types.
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
});

export const TerminalEvent = Schema.Union([
  TerminalStartedEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalClosedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
]);
export type TerminalEvent = typeof TerminalEvent.Type;

const TerminalAttachSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  snapshot: TerminalSessionSnapshot,
});

export const TerminalAttachStreamEvent = Schema.Union([
  TerminalAttachSnapshotEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalClosedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
]);
export type TerminalAttachStreamEvent = typeof TerminalAttachStreamEvent.Type;

export class TerminalCwdNotFoundError extends Schema.TaggedError<TerminalCwdNotFoundError>()(
  "TerminalCwdNotFoundError",
  {
    cwd: Schema.String,
  },
) {
  override get message() {
    return `Terminal folder does not exist: ${this.cwd}. Restore the folder at this path before retrying.`;
  }
}

export class TerminalCwdNotDirectoryError extends Schema.TaggedError<TerminalCwdNotDirectoryError>()(
  "TerminalCwdNotDirectoryError",
  {
    cwd: Schema.String,
  },
) {
  override get message() {
    return `Terminal cwd is not a directory: ${this.cwd}`;
  }
}

export class TerminalCwdStatError extends Schema.TaggedError<TerminalCwdStatError>()(
  "TerminalCwdStatError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to access terminal cwd: ${this.cwd}`;
  }
}

export const TerminalCwdError = Schema.Union([
  TerminalCwdNotFoundError,
  TerminalCwdNotDirectoryError,
  TerminalCwdStatError,
]);
export type TerminalCwdError = typeof TerminalCwdError.Type;

export class TerminalHistoryError extends Schema.TaggedError<TerminalHistoryError>()(
  "TerminalHistoryError",
  {
    operation: Schema.Literals(["read", "truncate", "migrate"]),
    threadId: Schema.String,
    terminalId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Failed to ${this.operation} terminal history for thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalSessionLookupError extends Schema.TaggedError<TerminalSessionLookupError>()(
  "TerminalSessionLookupError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Unknown terminal thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalProviderInstanceNotFoundError extends Schema.TaggedError<TerminalProviderInstanceNotFoundError>()(
  "TerminalProviderInstanceNotFoundError",
  {
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message() {
    return `Provider instance is not available: ${this.providerInstanceId}`;
  }
}

export class TerminalProviderEnvironmentError extends Schema.TaggedError<TerminalProviderEnvironmentError>()(
  "TerminalProviderEnvironmentError",
  {
    providerInstanceId: ProviderInstanceId,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not prepare the terminal environment for provider instance: ${this.providerInstanceId}`;
  }
}

export class TerminalNotRunningError extends Schema.TaggedError<TerminalNotRunningError>()(
  "TerminalNotRunningError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Terminal is not running for thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalWriteError extends Schema.TaggedError<TerminalWriteError>()(
  "TerminalWriteError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
    terminalPid: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to write to terminal for thread: ${this.threadId}, terminal: ${this.terminalId}, PID: ${this.terminalPid}`;
  }
}

export class TerminalResizeError extends Schema.TaggedError<TerminalResizeError>()(
  "TerminalResizeError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
    terminalPid: Schema.Number,
    cols: TerminalColsSchema,
    rows: TerminalRowsSchema,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to resize terminal for thread: ${this.threadId}, terminal: ${this.terminalId}, PID: ${this.terminalPid} to ${this.cols}x${this.rows}`;
  }
}

export const TerminalError = Schema.Union([
  TerminalCwdError,
  TerminalHistoryError,
  TerminalSessionLookupError,
  TerminalProviderInstanceNotFoundError,
  TerminalProviderEnvironmentError,
  TerminalNotRunningError,
  TerminalWriteError,
  TerminalResizeError,
]);
export type TerminalError = typeof TerminalError.Type;
