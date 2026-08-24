import type * as backup from "@distilled.cloud/aws/backup";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetSupportedResourceTypes` operation (IAM action
 * `backup:GetSupportedResourceTypes`).
 *
 * Returns the AWS resource types AWS Backup supports (e.g. `DynamoDB`,
 * `EBS`, `RDS`). Provide the implementation with
 * `Effect.provide(AWS.Backup.GetSupportedResourceTypesHttp)`.
 * @binding
 * @section Protected Resources
 * @example List Supported Resource Types
 * ```typescript
 * const getSupportedResourceTypes =
 *   yield* AWS.Backup.GetSupportedResourceTypes();
 *
 * const { ResourceTypes } = yield* getSupportedResourceTypes();
 * ```
 */
export interface GetSupportedResourceTypes extends Binding.Service<
  GetSupportedResourceTypes,
  "AWS.Backup.GetSupportedResourceTypes",
  () => Effect.Effect<
    (
      request?: backup.GetSupportedResourceTypesRequest,
    ) => Effect.Effect<
      backup.GetSupportedResourceTypesOutput,
      backup.GetSupportedResourceTypesError
    >
  >
> {}
export const GetSupportedResourceTypes =
  Binding.Service<GetSupportedResourceTypes>(
    "AWS.Backup.GetSupportedResourceTypes",
  );
