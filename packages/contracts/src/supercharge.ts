import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";

/**
 * Supercharge changes how a thread's turns run: the agent writes completion checks first, then
 * Continuum keeps the thread going (verify, fix, review) until the checks pass or a limit stops it.
 */
export const SuperchargePreset = Schema.Literals(["off", "verify", "deep"]);
export type SuperchargePreset = typeof SuperchargePreset.Type;

export const SuperchargeLimits = Schema.Struct({
  /** Follow-up turns Continuum may start after the first. */
  maxIterations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  maxMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 240 })),
  /** Total tokens the provider reports for the run. Null means no ceiling. */
  maxTokens: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 50_000_000 }))),
});
export type SuperchargeLimits = typeof SuperchargeLimits.Type;

export const SuperchargeConfig = Schema.Struct({
  preset: SuperchargePreset,
  limits: SuperchargeLimits,
  /** Deep may raise reasoning effort on the same model; switching models needs this. */
  allowModelSwitch: Schema.Boolean,
  /** Deep only: a reviewer starts with a fresh context and sees only the diff and checks. */
  independentReview: Schema.Boolean,
});
export type SuperchargeConfig = typeof SuperchargeConfig.Type;

export const SUPERCHARGE_DEFAULT_LIMITS: Record<Exclude<SuperchargePreset, "off">, SuperchargeLimits> =
  {
    verify: { maxIterations: 3, maxMinutes: 30, maxTokens: null },
    deep: { maxIterations: 5, maxMinutes: 60, maxTokens: null },
  };

export const DEFAULT_SUPERCHARGE_CONFIG: SuperchargeConfig = {
  preset: "off",
  limits: SUPERCHARGE_DEFAULT_LIMITS.verify,
  allowModelSwitch: false,
  independentReview: false,
};

export const SuperchargePhase = Schema.Literals([
  "implementing",
  "verifying",
  "fixing",
  "reviewing",
  "independent-review",
  "finished",
]);
export type SuperchargePhase = typeof SuperchargePhase.Type;

export const SuperchargeCheck = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["pass", "fail", "pending"]),
  evidence: Schema.String,
});
export type SuperchargeCheck = typeof SuperchargeCheck.Type;

export const SuperchargeStopReason = Schema.Literals([
  "checks-passed",
  "iteration-limit",
  "time-limit",
  "usage-limit",
  "cancelled",
  "stopped-by-user",
  "turn-failed",
  "no-report",
]);
export type SuperchargeStopReason = typeof SuperchargeStopReason.Type;

export const SuperchargeLogEntry = Schema.Struct({
  at: IsoDateTime,
  iteration: NonNegativeInt,
  phase: SuperchargePhase,
  summary: Schema.String,
});
export type SuperchargeLogEntry = typeof SuperchargeLogEntry.Type;

export const SuperchargeRun = Schema.Struct({
  preset: Schema.Literals(["verify", "deep"]),
  phase: SuperchargePhase,
  /** 0 for the user's own turn, then one per follow-up Continuum started. */
  iteration: NonNegativeInt,
  limits: SuperchargeLimits,
  startedAt: IsoDateTime,
  deadlineAt: IsoDateTime,
  tokensUsed: Schema.NullOr(NonNegativeInt),
  /** False when no provider reported usage and `tokensUsed` is an estimate from text length. */
  tokensMeasured: Schema.Boolean,
  checks: Schema.Array(SuperchargeCheck),
  testsRun: Schema.Array(Schema.String),
  /** The reasoning effort Deep asked for, when the model offers one. */
  effort: Schema.NullOr(Schema.String),
  stop: Schema.NullOr(
    Schema.Struct({ reason: SuperchargeStopReason, message: Schema.String, at: IsoDateTime }),
  ),
  log: Schema.Array(SuperchargeLogEntry),
});
export type SuperchargeRun = typeof SuperchargeRun.Type;

export const SuperchargeThreadState = Schema.Struct({
  threadId: ThreadId,
  config: SuperchargeConfig,
  run: Schema.NullOr(SuperchargeRun),
});
export type SuperchargeThreadState = typeof SuperchargeThreadState.Type;

export const SuperchargeThreadInput = Schema.Struct({ threadId: ThreadId });
export type SuperchargeThreadInput = typeof SuperchargeThreadInput.Type;

export const SuperchargeConfigureInput = Schema.Struct({
  threadId: ThreadId,
  config: SuperchargeConfig,
});
export type SuperchargeConfigureInput = typeof SuperchargeConfigureInput.Type;

export class SuperchargeError extends Schema.TaggedError<SuperchargeError>()("SuperchargeError", {
  message: Schema.String,
}) {}
