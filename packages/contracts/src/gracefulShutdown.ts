import * as Schema from "effect/Schema";

import { ProviderSessionId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2 * 60 * 1_000;

export const GracefulShutdownScope = Schema.Union([
  Schema.Struct({ type: Schema.Literal("environment") }),
  Schema.Struct({
    type: Schema.Literal("provider"),
    providerInstanceId: ProviderInstanceId,
  }),
  Schema.Struct({
    type: Schema.Literal("session"),
    providerSessionId: ProviderSessionId,
  }),
]);
export type GracefulShutdownScope = typeof GracefulShutdownScope.Type;

export const GracefulShutdownPhase = Schema.Literals(["idle", "draining", "quiesced", "timed_out"]);
export type GracefulShutdownPhase = typeof GracefulShutdownPhase.Type;

export const GracefulShutdownId = TrimmedNonEmptyString;
export type GracefulShutdownId = typeof GracefulShutdownId.Type;

export const GracefulShutdownInput = Schema.Struct({
  scope: GracefulShutdownScope,
  /** Wall-clock wait for in-scope work to finish after save prompts. Default 2 minutes. */
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1_000), Schema.isLessThanOrEqualTo(30 * 60_000)),
  ),
  /** When set, overrides the environment setting for this request only. */
  promptSaveWork: Schema.optionalKey(Schema.Boolean),
  reason: Schema.optionalKey(TrimmedNonEmptyString),
});
export type GracefulShutdownInput = typeof GracefulShutdownInput.Type;

export const GracefulShutdownStatus = Schema.Struct({
  phase: GracefulShutdownPhase,
  shutdownId: Schema.optionalKey(GracefulShutdownId),
  scope: Schema.optionalKey(GracefulShutdownScope),
  reason: Schema.optionalKey(TrimmedNonEmptyString),
  startedAt: Schema.optionalKey(Schema.String),
  deadlineAt: Schema.optionalKey(Schema.String),
  activeRunCount: Schema.Int,
  saveWorkPrompted: Schema.Boolean,
  saveWorkTurnCount: Schema.Int,
});
export type GracefulShutdownStatus = typeof GracefulShutdownStatus.Type;

export const GracefulShutdownResult = Schema.Struct({
  shutdownId: GracefulShutdownId,
  phase: Schema.Literals(["quiesced", "timed_out"]),
  scope: GracefulShutdownScope,
  timedOut: Schema.Boolean,
  activeRunCount: Schema.Int,
  saveWorkPrompted: Schema.Boolean,
  saveWorkTurnCount: Schema.Int,
  elapsedMs: Schema.Int,
});
export type GracefulShutdownResult = typeof GracefulShutdownResult.Type;

export class GracefulShutdownError extends Schema.TaggedError<GracefulShutdownError>()(
  "GracefulShutdownError",
  {
    reason: TrimmedNonEmptyString,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}
