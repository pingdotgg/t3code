import type * as config from "@distilled.cloud/aws/config-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `config:GetResourceConfigHistory` — read the list of
 * configuration items (change history) AWS Config recorded for a resource,
 * newest first.
 *
 * Provide `Config.GetResourceConfigHistoryHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Reading Resource Configurations
 * @example Read a Resource's Configuration History
 * ```typescript
 * // init — grants config:GetResourceConfigHistory
 * const getResourceConfigHistory = yield* AWS.Config.GetResourceConfigHistory();
 *
 * // runtime
 * const result = yield* getResourceConfigHistory({
 *   resourceType: "AWS::S3::Bucket",
 *   resourceId: "my-bucket",
 *   limit: 10,
 * });
 * console.log(result.configurationItems?.length);
 * ```
 */
export interface GetResourceConfigHistory extends Binding.Service<
  GetResourceConfigHistory,
  "AWS.Config.GetResourceConfigHistory",
  () => Effect.Effect<
    (
      request: config.GetResourceConfigHistoryRequest,
    ) => Effect.Effect<
      config.GetResourceConfigHistoryResponse,
      config.GetResourceConfigHistoryError
    >
  >
> {}

export const GetResourceConfigHistory =
  Binding.Service<GetResourceConfigHistory>(
    "AWS.Config.GetResourceConfigHistory",
  );
