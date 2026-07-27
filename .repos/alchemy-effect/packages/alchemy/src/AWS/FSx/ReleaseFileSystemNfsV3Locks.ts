import type * as fsx from "@distilled.cloud/aws/fsx";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FileSystem } from "./FileSystem.ts";

/**
 * Runtime binding for the `ReleaseFileSystemNfsV3Locks` operation scoped to
 * one OpenZFS file system (IAM action `fsx:ReleaseFileSystemNfsV3Locks` on
 * the file system ARN).
 *
 * Releases all NFSv3 byte-range locks held on the bound OpenZFS
 * {@link FileSystem} — the recovery action for clients that crashed while
 * holding locks and left files stuck. Provide the implementation with
 * `Effect.provide(AWS.FSx.ReleaseFileSystemNfsV3LocksHttp)`.
 * @binding
 * @section Operational Recovery
 * @example Release stuck NFSv3 locks
 * ```typescript
 * const releaseLocks = yield* AWS.FSx.ReleaseFileSystemNfsV3Locks(zfs);
 *
 * const response = yield* releaseLocks();
 * yield* Effect.log(`file system ${response.FileSystem?.FileSystemId} locks released`);
 * ```
 */
export interface ReleaseFileSystemNfsV3Locks extends Binding.Service<
  ReleaseFileSystemNfsV3Locks,
  "AWS.FSx.ReleaseFileSystemNfsV3Locks",
  (
    fileSystem: FileSystem,
  ) => Effect.Effect<
    (
      request?: Omit<fsx.ReleaseFileSystemNfsV3LocksRequest, "FileSystemId">,
    ) => Effect.Effect<
      fsx.ReleaseFileSystemNfsV3LocksResponse,
      fsx.ReleaseFileSystemNfsV3LocksError
    >
  >
> {}
export const ReleaseFileSystemNfsV3Locks =
  Binding.Service<ReleaseFileSystemNfsV3Locks>(
    "AWS.FSx.ReleaseFileSystemNfsV3Locks",
  );
