import type * as efs from "@distilled.cloud/aws/efs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FileSystem } from "./FileSystem.ts";

/**
 * `CreateAccessPoint` request with `FileSystemId` injected from the bound
 * {@link FileSystem}.
 */
export interface CreateAccessPointRequest extends Omit<
  efs.CreateAccessPointRequest,
  "FileSystemId"
> {}

/**
 * Runtime binding for the `CreateAccessPoint` operation (IAM actions
 * `elasticfilesystem:CreateAccessPoint` on the file system ARN and
 * `elasticfilesystem:TagResource` for tag-on-create).
 *
 * Creates an access point into the bound {@link FileSystem} at runtime —
 * the multi-tenant pattern where each tenant gets its own POSIX identity
 * and root directory carved out of one file system. `ClientToken` makes the
 * create idempotent; a repeated identical create surfaces the typed
 * `AccessPointAlreadyExists`. For statically-known access points, prefer the
 * {@link AccessPoint} resource. Provide the implementation with
 * `Effect.provide(AWS.EFS.CreateAccessPointHttp)`.
 * @binding
 * @section Managing Access Points at Runtime
 * @example Create a per-tenant access point
 * ```typescript
 * const createAccessPoint = yield* AWS.EFS.CreateAccessPoint(files);
 *
 * const accessPoint = yield* createAccessPoint({
 *   ClientToken: `tenant-${tenantId}`,
 *   PosixUser: { Uid: 1000, Gid: 1000 },
 *   RootDirectory: {
 *     Path: `/tenants/${tenantId}`,
 *     CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: "750" },
 *   },
 * });
 * ```
 */
export interface CreateAccessPoint extends Binding.Service<
  CreateAccessPoint,
  "AWS.EFS.CreateAccessPoint",
  (
    fileSystem: FileSystem,
  ) => Effect.Effect<
    (
      request: CreateAccessPointRequest,
    ) => Effect.Effect<efs.AccessPointDescription, efs.CreateAccessPointError>
  >
> {}
export const CreateAccessPoint = Binding.Service<CreateAccessPoint>(
  "AWS.EFS.CreateAccessPoint",
);
