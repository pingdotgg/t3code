import { Schema } from "effect";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SimulatorSessionId = TrimmedNonEmptyString.pipe(Schema.brand("SimulatorSessionId"));
export type SimulatorSessionId = typeof SimulatorSessionId.Type;

export const SimulatorActionId = PositiveInt.pipe(Schema.brand("SimulatorActionId"));
export type SimulatorActionId = typeof SimulatorActionId.Type;

export const SimulatorPoint = Schema.Struct({
  x: NonNegativeInt,
  y: NonNegativeInt,
});
export type SimulatorPoint = typeof SimulatorPoint.Type;

export const SimulatorOpenInput = Schema.Struct({
  udid: Schema.optional(TrimmedNonEmptyString),
  deviceName: Schema.optional(TrimmedNonEmptyString),
  appBundleId: Schema.optional(TrimmedNonEmptyString),
  appPath: Schema.optional(TrimmedNonEmptyString),
  launchArgs: Schema.optional(Schema.Array(Schema.String)),
});
export type SimulatorOpenInput = typeof SimulatorOpenInput.Type;

export const SimulatorSession = Schema.Struct({
  sessionId: SimulatorSessionId,
  udid: TrimmedNonEmptyString,
  deviceName: TrimmedNonEmptyString,
  state: Schema.Literals(["ready", "closed"]),
  appBundleId: Schema.optional(TrimmedNonEmptyString),
  artifactDirectory: TrimmedNonEmptyString,
});
export type SimulatorSession = typeof SimulatorSession.Type;

export const SimulatorTapInput = Schema.Struct({
  sessionId: SimulatorSessionId,
  point: SimulatorPoint,
});
export type SimulatorTapInput = typeof SimulatorTapInput.Type;

export const SimulatorSwipeInput = Schema.Struct({
  sessionId: SimulatorSessionId,
  from: SimulatorPoint,
  to: SimulatorPoint,
  durationMs: Schema.optional(PositiveInt),
});
export type SimulatorSwipeInput = typeof SimulatorSwipeInput.Type;

export const SimulatorTypeInput = Schema.Struct({
  sessionId: SimulatorSessionId,
  text: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(4_000)),
});
export type SimulatorTypeInput = typeof SimulatorTypeInput.Type;

export const SimulatorScreenshotInput = Schema.Struct({
  sessionId: SimulatorSessionId,
  label: Schema.optional(TrimmedNonEmptyString),
});
export type SimulatorScreenshotInput = typeof SimulatorScreenshotInput.Type;

export const SimulatorVideoStartInput = Schema.Struct({
  sessionId: SimulatorSessionId,
  label: Schema.optional(TrimmedNonEmptyString),
});
export type SimulatorVideoStartInput = typeof SimulatorVideoStartInput.Type;

export const SimulatorArtifact = Schema.Struct({
  kind: Schema.Literals(["screenshot", "video", "logs"]),
  path: TrimmedNonEmptyString,
  bytes: NonNegativeInt,
  sha256: TrimmedNonEmptyString,
});
export type SimulatorArtifact = typeof SimulatorArtifact.Type;

export const SimulatorActionReceipt = Schema.Struct({
  sessionId: SimulatorSessionId,
  actionId: SimulatorActionId,
  durationMs: NonNegativeInt,
  state: Schema.Literal("completed"),
});
export type SimulatorActionReceipt = typeof SimulatorActionReceipt.Type;

export const SimulatorVideoStartResult = Schema.Struct({
  sessionId: SimulatorSessionId,
  state: Schema.Literal("recording"),
  path: TrimmedNonEmptyString,
});
export type SimulatorVideoStartResult = typeof SimulatorVideoStartResult.Type;

export const SimulatorLogsInput = Schema.Struct({
  sessionId: SimulatorSessionId,
  lastSeconds: Schema.optional(PositiveInt),
});
export type SimulatorLogsInput = typeof SimulatorLogsInput.Type;

export const SimulatorMetricsInput = Schema.Struct({ sessionId: SimulatorSessionId });
export type SimulatorMetricsInput = typeof SimulatorMetricsInput.Type;

export const SimulatorMetrics = Schema.Struct({
  sessionId: SimulatorSessionId,
  sampledAt: Schema.String,
  cpuPercent: Schema.NullOr(Schema.Number),
  memoryBytes: Schema.NullOr(Schema.Number),
});
export type SimulatorMetrics = typeof SimulatorMetrics.Type;

export const SimulatorCloseInput = Schema.Struct({ sessionId: SimulatorSessionId });
export type SimulatorCloseInput = typeof SimulatorCloseInput.Type;

export class SimulatorToolkitError extends Schema.TaggedError<SimulatorToolkitError>()(
  "SimulatorToolkitError",
  {
    code: Schema.Literals([
      "unsupported_host",
      "session_not_found",
      "device_not_found",
      "command_failed",
      "recording_not_started",
    ]),
    detail: Schema.String,
  },
) {}
