import * as Data from "effect/Data";

export class SnapshotListError extends Data.TaggedError("SnapshotListError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class SnapshotCreationError extends Data.TaggedError("SnapshotCreationError")<{
  readonly message: string;
  readonly snapshotName: string;
  readonly cause: unknown;
}> {}

export class SnapshotDeletionError extends Data.TaggedError("SnapshotDeletionError")<{
  readonly message: string;
  readonly snapshotName: string;
  readonly cause: unknown;
}> {}

export class SnapshotActivationError extends Data.TaggedError("SnapshotActivationError")<{
  readonly message: string;
  readonly snapshotName: string;
  readonly cause: unknown;
}> {}

export type EnsureSnapshotError =
  | SnapshotActivationError
  | SnapshotCreationError
  | SnapshotDeletionError
  | SnapshotListError;
