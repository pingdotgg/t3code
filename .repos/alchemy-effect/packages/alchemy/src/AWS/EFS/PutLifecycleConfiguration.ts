import type * as efs from "@distilled.cloud/aws/efs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FileSystem } from "./FileSystem.ts";

/**
 * `PutLifecycleConfiguration` request with `FileSystemId` injected from the
 * bound {@link FileSystem}.
 */
export interface PutLifecycleConfigurationRequest extends Omit<
  efs.PutLifecycleConfigurationRequest,
  "FileSystemId"
> {}

/**
 * Runtime binding for the `PutLifecycleConfiguration` operation (IAM action
 * `elasticfilesystem:PutLifecycleConfiguration` on the file system ARN).
 *
 * Replaces the bound {@link FileSystem}'s lifecycle management rules at
 * runtime; an empty `LifecyclePolicies` array disables lifecycle management.
 * For declarative control, prefer the FileSystem resource's
 * `lifecyclePolicies` prop — this binding is for operational tooling that
 * tunes storage tiering on demand. Provide the implementation with
 * `Effect.provide(AWS.EFS.PutLifecycleConfigurationHttp)`.
 * @binding
 * @section Lifecycle Management
 * @example Tier cold files to Infrequent Access
 * ```typescript
 * const putLifecycleConfiguration =
 *   yield* AWS.EFS.PutLifecycleConfiguration(files);
 *
 * yield* putLifecycleConfiguration({
 *   LifecyclePolicies: [{ TransitionToIA: "AFTER_30_DAYS" }],
 * });
 * ```
 */
export interface PutLifecycleConfiguration extends Binding.Service<
  PutLifecycleConfiguration,
  "AWS.EFS.PutLifecycleConfiguration",
  (
    fileSystem: FileSystem,
  ) => Effect.Effect<
    (
      request: PutLifecycleConfigurationRequest,
    ) => Effect.Effect<
      efs.LifecycleConfigurationDescription,
      efs.PutLifecycleConfigurationError
    >
  >
> {}
export const PutLifecycleConfiguration =
  Binding.Service<PutLifecycleConfiguration>(
    "AWS.EFS.PutLifecycleConfiguration",
  );
