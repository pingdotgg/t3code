import * as Schema from "effect/Schema";

import { CommandId, IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import { OrchestrationThreadShell } from "./orchestration.ts";

export const PiNativeSessionKey = Schema.String.pipe(Schema.brand("PiNativeSessionKey"));
export type PiNativeSessionKey = typeof PiNativeSessionKey.Type;
export const PiNativeRuntimeId = Schema.String.pipe(Schema.brand("PiNativeRuntimeId"));
export type PiNativeRuntimeId = typeof PiNativeRuntimeId.Type;
export const PiNativeEventId = Schema.String.pipe(Schema.brand("PiNativeEventId"));
export type PiNativeEventId = typeof PiNativeEventId.Type;

export const PiNativeJsonlEntry = Schema.Record(Schema.String, Schema.Unknown);
export type PiNativeJsonlEntry = typeof PiNativeJsonlEntry.Type;
export const PI_THREAD_LIFECYCLE_CUSTOM_TYPE = "t3.thread-lifecycle.v1";
export const PiThreadLifecycleOverride = Schema.Literals(["settled", "active"]);
export type PiThreadLifecycleOverride = typeof PiThreadLifecycleOverride.Type;
export const PiThreadLifecycleData = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  override: PiThreadLifecycleOverride,
  operationId: CommandId,
});
export type PiThreadLifecycleData = typeof PiThreadLifecycleData.Type;
export const PiThreadLifecycleCustomEntry = Schema.Struct({
  type: Schema.Literal("custom"),
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  timestamp: IsoDateTime,
  customType: Schema.Literal(PI_THREAD_LIFECYCLE_CUSTOM_TYPE),
  data: PiThreadLifecycleData,
});
export type PiThreadLifecycleCustomEntry = typeof PiThreadLifecycleCustomEntry.Type;
export const PiNativeLiveness = Schema.Literals(["live", "historical", "unmanaged"]);
export type PiNativeLiveness = typeof PiNativeLiveness.Type;
export const PiNativeWriterKind = Schema.Literals(["rpc", "tuiBridge"]);
export type PiNativeWriterKind = typeof PiNativeWriterKind.Type;

export const PiNativeRuntimeOverlay = Schema.Struct({
  isStreaming: Schema.Boolean,
  pendingMessageCount: NonNegativeInt,
  lastEventType: Schema.optional(Schema.String),
});
export type PiNativeRuntimeOverlay = typeof PiNativeRuntimeOverlay.Type;

export const PiNativeRuntimeState = Schema.Struct({
  runtimeId: PiNativeRuntimeId,
  sessionKey: Schema.optional(PiNativeSessionKey),
  cwd: Schema.optional(Schema.String),
  writerKind: PiNativeWriterKind,
  status: Schema.Literals(["starting", "idle", "streaming", "exited"]),
  sequence: NonNegativeInt,
  state: Schema.optional(Schema.Unknown),
  overlay: Schema.optional(PiNativeRuntimeOverlay),
});
export type PiNativeRuntimeState = typeof PiNativeRuntimeState.Type;

export const PiNativeSession = Schema.Struct({
  sessionKey: PiNativeSessionKey,
  sessionId: Schema.String,
  cwd: Schema.String,
  title: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  liveness: PiNativeLiveness,
  runtime: Schema.optional(PiNativeRuntimeState),
});
export type PiNativeSession = typeof PiNativeSession.Type;
export const PiNativeListResult = Schema.Struct({
  sessions: Schema.Array(PiNativeSession),
  runtimes: Schema.Array(PiNativeRuntimeState),
});
export const PiNativeReadInput = Schema.Struct({ sessionKey: PiNativeSessionKey });
export const PiNativeReadResult = Schema.Struct({
  session: PiNativeSession,
  entries: Schema.Array(PiNativeJsonlEntry),
});

export const PiNativeCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("start"), commandId: CommandId, cwd: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("resume"),
    commandId: CommandId,
    sessionKey: PiNativeSessionKey,
  }),
  Schema.Struct({
    type: Schema.Literals(["send", "steer", "followUp"]),
    commandId: CommandId,
    runtimeId: PiNativeRuntimeId,
    message: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["abort", "shutdown"]),
    commandId: CommandId,
    runtimeId: PiNativeRuntimeId,
  }),
]);
export type PiNativeCommand = typeof PiNativeCommand.Type;
export const PiNativeCommandReceipt = Schema.Struct({
  commandId: CommandId,
  status: Schema.Literals(["started", "completed", "rejected", "indeterminate"]),
  runtimeId: Schema.optional(PiNativeRuntimeId),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});
export type PiNativeCommandReceipt = typeof PiNativeCommandReceipt.Type;

export const PiNativeSubscribeInput = Schema.Struct({
  runtimeId: PiNativeRuntimeId,
  cursor: Schema.optional(NonNegativeInt),
});
export const PiNativeStreamEvent = Schema.Struct({
  type: Schema.Literal("event"),
  runtimeId: PiNativeRuntimeId,
  sequence: NonNegativeInt,
  eventId: PiNativeEventId,
  event: Schema.Unknown,
});
export type PiNativeStreamEvent = typeof PiNativeStreamEvent.Type;
export const PiNativeStreamItem = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    runtime: PiNativeRuntimeState,
    entries: Schema.Array(PiNativeJsonlEntry),
    events: Schema.Array(PiNativeStreamEvent),
  }),
  PiNativeStreamEvent,
  Schema.Struct({
    type: Schema.Literal("entries"),
    runtimeId: PiNativeRuntimeId,
    sequence: NonNegativeInt,
    entries: Schema.Array(PiNativeJsonlEntry),
  }),
  Schema.Struct({
    type: Schema.Literal("synchronized"),
    runtimeId: PiNativeRuntimeId,
    sequence: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("exited"),
    runtimeId: PiNativeRuntimeId,
    sequence: NonNegativeInt,
    exitCode: Schema.optional(Schema.Number),
  }),
]);
export type PiNativeStreamItem = typeof PiNativeStreamItem.Type;

export const PiExternalCatalogSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  threads: Schema.Array(OrchestrationThreadShell),
  omittedThreadCount: NonNegativeInt,
  updatedAt: Schema.String,
});
export type PiExternalCatalogSnapshot = typeof PiExternalCatalogSnapshot.Type;

export const PiExternalCatalogSubscribeInput = Schema.Struct({
  afterSequence: Schema.optional(NonNegativeInt),
  requestCompletionMarker: Schema.optional(Schema.Boolean),
});
export type PiExternalCatalogSubscribeInput = typeof PiExternalCatalogSubscribeInput.Type;
export const PiExternalCatalogStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: PiExternalCatalogSnapshot,
  }),
  Schema.Struct({ kind: Schema.Literal("synchronized") }),
]);
export type PiExternalCatalogStreamItem = typeof PiExternalCatalogStreamItem.Type;

export const PiExternalCreateSessionInput = Schema.Struct({
  commandId: CommandId,
  cwd: Schema.String,
});
export type PiExternalCreateSessionInput = typeof PiExternalCreateSessionInput.Type;
export const PiExternalCreateSessionResult = Schema.Struct({
  threadId: ThreadId,
});
export type PiExternalCreateSessionResult = typeof PiExternalCreateSessionResult.Type;

export class PiNativeError extends Schema.TaggedErrorClass<PiNativeError>()("PiNativeError", {
  code: Schema.String,
  message: Schema.String,
}) {}
