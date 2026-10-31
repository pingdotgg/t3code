import type { LinearDraftIssue } from "@t3tools/client-runtime/linear/launch-plan";
import * as Schema from "effect/Schema";

/** Persisted form of a draft started from an issue; mirrors `LinearDraftIssue`. */
export const LinearDraftIssueSchema = Schema.Struct({
  issueId: Schema.String,
  identifier: Schema.String,
  teamId: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.String),
  branchName: Schema.String,
  mappedProjectId: Schema.NullOr(Schema.String),
  moveTo: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
  moveEnabled: Schema.Boolean,
  commentEnabled: Schema.Boolean,
}) satisfies Schema.Codec<LinearDraftIssue, unknown>;
