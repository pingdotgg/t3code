import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ProviderAuthAction = Schema.Literals(["signIn", "signOut"]);
export type ProviderAuthAction = typeof ProviderAuthAction.Type;

export const ProviderAuthSessionId = TrimmedNonEmptyString.pipe(
  Schema.brand("ProviderAuthSessionId"),
);
export type ProviderAuthSessionId = typeof ProviderAuthSessionId.Type;

export const ProviderAuthSessionStatus = Schema.Literals([
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type ProviderAuthSessionStatus = typeof ProviderAuthSessionStatus.Type;

export const ProviderAuthSessionSnapshot = Schema.Struct({
  sessionId: ProviderAuthSessionId,
  instanceId: ProviderInstanceId,
  action: ProviderAuthAction,
  status: ProviderAuthSessionStatus,
  history: Schema.String.check(Schema.isMaxLength(262_144)),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_048))),
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ProviderAuthSessionSnapshot = typeof ProviderAuthSessionSnapshot.Type;

export const ProviderAuthStartInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  action: ProviderAuthAction,
  cols: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(1_000)),
  ),
  rows: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(500)),
  ),
});
export type ProviderAuthStartInput = typeof ProviderAuthStartInput.Type;

export const ProviderAuthAttachInput = Schema.Struct({
  sessionId: ProviderAuthSessionId,
});
export type ProviderAuthAttachInput = typeof ProviderAuthAttachInput.Type;

export const ProviderAuthWriteInput = Schema.Struct({
  sessionId: ProviderAuthSessionId,
  data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
});
export type ProviderAuthWriteInput = typeof ProviderAuthWriteInput.Type;

export const ProviderAuthResizeInput = Schema.Struct({
  sessionId: ProviderAuthSessionId,
  cols: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(1_000)),
  rows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(500)),
});
export type ProviderAuthResizeInput = typeof ProviderAuthResizeInput.Type;

export const ProviderAuthCancelInput = ProviderAuthAttachInput;
export type ProviderAuthCancelInput = typeof ProviderAuthCancelInput.Type;

const ProviderAuthStreamEventBase = Schema.Struct({
  sessionId: ProviderAuthSessionId,
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const ProviderAuthAttachStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    snapshot: ProviderAuthSessionSnapshot,
  }),
  Schema.Struct({
    ...ProviderAuthStreamEventBase.fields,
    type: Schema.Literal("output"),
    data: Schema.String,
  }),
  Schema.Struct({
    ...ProviderAuthStreamEventBase.fields,
    type: Schema.Literal("settled"),
    snapshot: ProviderAuthSessionSnapshot,
  }),
]);
export type ProviderAuthAttachStreamEvent = typeof ProviderAuthAttachStreamEvent.Type;

export const ProviderAuthErrorReason = Schema.Literals([
  "instance-not-found",
  "unsupported",
  "not-installed",
  "session-conflict",
  "session-not-found",
  "session-not-running",
  "spawn-failed",
]);
export type ProviderAuthErrorReason = typeof ProviderAuthErrorReason.Type;

export class ProviderAuthError extends Schema.TaggedErrorClass<ProviderAuthError>()(
  "ProviderAuthError",
  {
    reason: ProviderAuthErrorReason,
    message: TrimmedNonEmptyString,
    instanceId: Schema.optional(ProviderInstanceId),
    sessionId: Schema.optional(ProviderAuthSessionId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
