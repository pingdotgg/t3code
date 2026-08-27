import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PostHogCloudTaskId = TrimmedNonEmptyString.pipe(Schema.brand("PostHogCloudTaskId"));
export type PostHogCloudTaskId = typeof PostHogCloudTaskId.Type;

export const PostHogCloudRunId = TrimmedNonEmptyString.pipe(Schema.brand("PostHogCloudRunId"));
export type PostHogCloudRunId = typeof PostHogCloudRunId.Type;

export const PostHogCloudRunStatus = Schema.Literals([
  "not_started",
  "queued",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
]);
export type PostHogCloudRunStatus = typeof PostHogCloudRunStatus.Type;

export const PostHogCloudRunArtifact = Schema.Struct({
  id: Schema.String,
  type: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  content_type: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Unknown),
  url: Schema.optional(Schema.String),
});
export type PostHogCloudRunArtifact = typeof PostHogCloudRunArtifact.Type;

export const PostHogCloudRun = Schema.Struct({
  id: PostHogCloudRunId,
  task: PostHogCloudTaskId,
  status: PostHogCloudRunStatus,
  stage: Schema.optional(Schema.NullOr(Schema.String)),
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  runtime_adapter: Schema.optional(Schema.NullOr(Schema.Literals(["claude", "codex"]))),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  reasoning_effort: Schema.optional(Schema.NullOr(Schema.String)),
  error_message: Schema.optional(Schema.NullOr(Schema.String)),
  output: Schema.optional(Schema.Unknown),
  state: Schema.optional(Schema.Unknown),
  artifacts: Schema.Array(PostHogCloudRunArtifact).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  created_at: Schema.String,
  updated_at: Schema.String,
  completed_at: Schema.optional(Schema.NullOr(Schema.String)),
});
export type PostHogCloudRun = typeof PostHogCloudRun.Type;

export const PostHogCloudTask = Schema.Struct({
  id: PostHogCloudTaskId,
  title: Schema.String,
  description: Schema.String,
  repository: Schema.optional(Schema.NullOr(Schema.String)),
  repositories: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  latest_run: Schema.optional(Schema.NullOr(PostHogCloudRun)),
  created_at: Schema.String,
  updated_at: Schema.String,
});
export type PostHogCloudTask = typeof PostHogCloudTask.Type;

export const PostHogCloudModel = Schema.Struct({
  runtime_adapter: Schema.Literals(["claude", "codex"]),
  model: TrimmedNonEmptyString,
  display_name: TrimmedNonEmptyString,
  supported_efforts: Schema.Array(Schema.String),
});
export type PostHogCloudModel = typeof PostHogCloudModel.Type;

export const PostHogCloudRuntimePayload = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  taskId: Schema.optional(PostHogCloudTaskId),
  repository: Schema.optional(TrimmedNonEmptyString),
});
export type PostHogCloudRuntimePayload = typeof PostHogCloudRuntimePayload.Type;

export const PostHogCloudResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runId: Schema.optional(PostHogCloudRunId),
  lastEventId: Schema.optional(TrimmedNonEmptyString),
});
export type PostHogCloudResumeCursor = typeof PostHogCloudResumeCursor.Type;

export const PostHogCloudStreamEvent = Schema.Struct({
  event: Schema.String,
  id: Schema.optional(Schema.String),
  data: Schema.Unknown,
});
export type PostHogCloudStreamEvent = typeof PostHogCloudStreamEvent.Type;

export const PostHogCloudCommandResult = Schema.Struct({
  response: Schema.optional(Schema.Unknown),
});
export type PostHogCloudCommandResult = typeof PostHogCloudCommandResult.Type;
