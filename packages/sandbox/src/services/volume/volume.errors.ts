import * as Data from "effect/Data";

export class VolumeListError extends Data.TaggedError("VolumeListError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class VolumeLookupError extends Data.TaggedError("VolumeLookupError")<{
  readonly message: string;
  readonly volumeName: string;
  readonly cause: unknown;
}> {}

export class VolumeEnsureError extends Data.TaggedError("VolumeEnsureError")<{
  readonly message: string;
  readonly volumeName: string;
  readonly cause: unknown;
}> {}

export class VolumeNotReadyError extends Data.TaggedError("VolumeNotReadyError")<{
  readonly message: string;
  readonly volumeName: string;
  readonly currentState: string;
  readonly cause?: unknown;
}> {}

export class VolumeDeleteError extends Data.TaggedError("VolumeDeleteError")<{
  readonly message: string;
  readonly volumeName: string;
  readonly cause: unknown;
}> {}

export type DeleteVolumeError = VolumeLookupError | VolumeDeleteError;

export type EnsureVolumeError = VolumeEnsureError | VolumeLookupError | VolumeNotReadyError;
