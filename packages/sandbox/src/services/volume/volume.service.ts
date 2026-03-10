import type { Daytona } from "@daytonaio/sdk";
import type * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";

import type {
  DeleteVolumeError,
  EnsureVolumeError,
  VolumeListError,
  VolumeLookupError,
} from "./volume.errors";

export type DaytonaVolume = Awaited<ReturnType<Daytona["volume"]["get"]>>;

export interface VolumeServiceShape {
  readonly listVolumes: () => Effect.Effect<ReadonlyArray<DaytonaVolume>, VolumeListError>;
  readonly getVolume: (name: string) => Effect.Effect<DaytonaVolume, VolumeLookupError>;
  /**
   * Ensures a Daytona volume exists and waits until Daytona reports it as ready.
   *
   * Practical limitation: the mounted filesystem is suitable for persisted file
   * storage, but live verification showed it does not currently support a normal
   * Git checkout on the mounted path. Cloning `affil-ai/affil` into the mounted
   * volume failed with `unable to write symref for HEAD: Function not implemented`.
   * Treat these volumes as persistent file storage, not as a drop-in replacement
   * for a local POSIX filesystem that can host `.git` metadata.
   */
  readonly ensureVolume: (name: string) => Effect.Effect<DaytonaVolume, EnsureVolumeError>;
  readonly deleteVolume: (name: string) => Effect.Effect<void, DeleteVolumeError>;
}

export class VolumeService extends ServiceMap.Service<VolumeService, VolumeServiceShape>()(
  "@repo/sandbox/services/volume/VolumeService",
) {}
