import type * as backup from "@distilled.cloud/aws/backup";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetRestoreJobMetadata` operation (IAM action
 * `backup:GetRestoreJobMetadata`).
 *
 * Returns the metadata of a restore job — the key/value set describing the
 * restored resource. Together with `PutRestoreValidationResult` this is the
 * restore-testing validation flow: AWS Backup invokes a validation Lambda
 * after a restore-test job completes, the Lambda inspects the restored
 * resource, then reports the verdict. Provide the implementation with
 * `Effect.provide(AWS.Backup.GetRestoreJobMetadataHttp)`.
 * @binding
 * @section Restore Testing Validation
 * @example Inspect A Restore Test's Metadata
 * ```typescript
 * const getRestoreJobMetadata = yield* AWS.Backup.GetRestoreJobMetadata();
 *
 * const { Metadata } = yield* getRestoreJobMetadata({
 *   RestoreJobId: restoreJobId,
 * });
 * yield* Effect.log(`restored resource metadata: ${JSON.stringify(Metadata)}`);
 * ```
 */
export interface GetRestoreJobMetadata extends Binding.Service<
  GetRestoreJobMetadata,
  "AWS.Backup.GetRestoreJobMetadata",
  () => Effect.Effect<
    (
      request: backup.GetRestoreJobMetadataInput,
    ) => Effect.Effect<
      backup.GetRestoreJobMetadataOutput,
      backup.GetRestoreJobMetadataError
    >
  >
> {}
export const GetRestoreJobMetadata = Binding.Service<GetRestoreJobMetadata>(
  "AWS.Backup.GetRestoreJobMetadata",
);
