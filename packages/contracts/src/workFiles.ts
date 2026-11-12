import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";

/** Whether work moving to another environment brings its working directory's files. */
export const WorkFilesMode = Schema.Literals(["transfer", "skip"]);
export type WorkFilesMode = typeof WorkFilesMode.Type;

/** What a thread's working directory would carry to another environment. */
export const WorkFilesSummary = Schema.Struct({
  directory: Schema.String,
  fileCount: Schema.Int,
  totalBytes: Schema.Int,
  deletionCount: Schema.Int,
  /** Files that look like secrets, which stay on this machine. */
  leftBehindCount: Schema.Int,
  /** Why the files cannot go, with the numbers; null when they can. */
  refusal: Schema.NullOr(Schema.String),
});
export type WorkFilesSummary = typeof WorkFilesSummary.Type;

export const ThreadWorkFilesSummaryInput = Schema.Struct({ threadId: ThreadId });
export type ThreadWorkFilesSummaryInput = typeof ThreadWorkFilesSummaryInput.Type;

export const ThreadContinueOnEnvironmentInput = Schema.Struct({
  threadId: ThreadId,
  /** A linked environment this one reaches. */
  environmentId: EnvironmentId,
  workFiles: WorkFilesMode,
});
export type ThreadContinueOnEnvironmentInput = typeof ThreadContinueOnEnvironmentInput.Type;

export const ThreadContinueOnEnvironmentResult = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projectId: ProjectId,
  /** What this environment calls the other one. */
  label: Schema.String,
  transferredFiles: Schema.Int,
});
export type ThreadContinueOnEnvironmentResult = typeof ThreadContinueOnEnvironmentResult.Type;

export class WorkFilesTransferError extends Schema.TaggedError<WorkFilesTransferError>()(
  "WorkFilesTransferError",
  { message: Schema.String },
) {}

/** Asks a linked environment for a one-time upload to its project's checkout. */
export const WorkFilesReceiveInput = Schema.Struct({
  projectId: ProjectId,
  /** The source checkout's HEAD; null outside git, "" before the first commit. */
  head: Schema.NullOr(Schema.String),
  deletions: Schema.Array(Schema.String).check(Schema.isMaxLength(5_000)),
});
export type WorkFilesReceiveInput = typeof WorkFilesReceiveInput.Type;

export const WorkFilesReceiveResult = Schema.Struct({
  /** POST the gzip tar here, on the same origin, with the link's bearer token. */
  relativeUrl: Schema.String,
  expiresAt: Schema.Number,
});
export type WorkFilesReceiveResult = typeof WorkFilesReceiveResult.Type;

export const WorkFilesApplied = Schema.Struct({ files: Schema.Int, deletions: Schema.Int });
export type WorkFilesApplied = typeof WorkFilesApplied.Type;
