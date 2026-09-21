import {
  IsoDateTime,
  ModelSelection,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const PendingUsageLimitContinuation = Schema.Struct({
  failedTurnId: TurnId,
  providerInstanceId: ProviderInstanceId,
  modelSelection: ModelSelection,
  errorMessage: Schema.String,
  failedAt: IsoDateTime,
  nextCheckAt: IsoDateTime,
  snapshotSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type PendingUsageLimitContinuation = typeof PendingUsageLimitContinuation.Type;

export const SetUsageLimitContinuationInput = Schema.Struct({
  threadId: ThreadId,
  pending: Schema.NullOr(PendingUsageLimitContinuation),
  expectedFailedTurnId: Schema.optional(TurnId),
});
export type SetUsageLimitContinuationInput = typeof SetUsageLimitContinuationInput.Type;

const decodePayload = Schema.decodeUnknownOption(
  Schema.Struct({
    usageLimitContinuation: PendingUsageLimitContinuation,
  }),
);

export function readPendingUsageLimitContinuation(
  runtimePayload: unknown,
): PendingUsageLimitContinuation | undefined {
  return Option.getOrUndefined(decodePayload(runtimePayload))?.usageLimitContinuation;
}
