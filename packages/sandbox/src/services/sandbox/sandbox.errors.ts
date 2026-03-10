import * as Data from "effect/Data";

export class InvalidSandboxMountPathError extends Data.TaggedError("InvalidSandboxMountPathError")<{
  readonly message: string;
  readonly mountPath: string;
}> {}

export class SandboxSnapshotLookupError extends Data.TaggedError("SandboxSnapshotLookupError")<{
  readonly message: string;
  readonly snapshotName: string;
  readonly cause: unknown;
}> {}

export class ManagedSandboxCreateError extends Data.TaggedError("ManagedSandboxCreateError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class ManagedSandboxLookupError extends Data.TaggedError("ManagedSandboxLookupError")<{
  readonly message: string;
  readonly sandboxId: string;
  readonly cause: unknown;
}> {}

export class ManagedSandboxDeleteError extends Data.TaggedError("ManagedSandboxDeleteError")<{
  readonly message: string;
  readonly sandboxId: string;
  readonly cause: unknown;
}> {}

export class ManagedSandboxStartError extends Data.TaggedError("ManagedSandboxStartError")<{
  readonly message: string;
  readonly sandboxId: string;
  readonly cause: unknown;
}> {}

export class ManagedSandboxStopError extends Data.TaggedError("ManagedSandboxStopError")<{
  readonly message: string;
  readonly sandboxId: string;
  readonly cause: unknown;
}> {}

export type CreateSandboxError =
  | InvalidSandboxMountPathError
  | SandboxSnapshotLookupError
  | ManagedSandboxCreateError;

export type DeleteSandboxError = ManagedSandboxLookupError | ManagedSandboxDeleteError;

export type StartSandboxError = ManagedSandboxLookupError | ManagedSandboxStartError;

export type StopSandboxError = ManagedSandboxLookupError | ManagedSandboxStopError;
