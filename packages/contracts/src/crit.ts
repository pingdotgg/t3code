import * as Schema from "effect/Schema";
import {
  CheckpointRef,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const CritReviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  scope: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("working-tree") }),
    Schema.Struct({ kind: Schema.Literal("branch"), baseRef: TrimmedNonEmptyString }),
    Schema.Struct({
      kind: Schema.Literal("pull-request"),
      provider: Schema.Literals(["github", "gitlab"]),
      url: TrimmedNonEmptyString,
      number: PositiveInt,
      commit: Schema.optional(TrimmedNonEmptyString),
    }),
    Schema.Struct({
      kind: Schema.Literal("turn"),
      threadId: ThreadId,
      fromTurnCount: NonNegativeInt,
      fromRef: Schema.optional(CheckpointRef),
      toRef: CheckpointRef,
    }),
  ]),
});
export const CritOpenInput = Schema.Struct({
  ...CritReviewInput.fields,
  tailscale: Schema.optional(Schema.Boolean),
  // Older SSH clients must fail explicitly before opening a browser on the host.
  portlessPort: Schema.optional(PositiveInt),
});
export type CritOpenInput = typeof CritOpenInput.Type;

export class CritOpenError extends Schema.TaggedError<CritOpenError>()("CritOpenError", {
  message: Schema.String,
}) {}
