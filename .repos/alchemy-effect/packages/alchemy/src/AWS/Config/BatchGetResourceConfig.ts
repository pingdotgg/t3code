import type * as config from "@distilled.cloud/aws/config-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `config:BatchGetResourceConfig` — fetch the current
 * configuration item for up to 100 recorded resources identified by
 * resource keys. Keys the recorder has not discovered come back in
 * `unprocessedResourceKeys`.
 *
 * Provide `Config.BatchGetResourceConfigHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Reading Resource Configurations
 * @example Batch-Read Current Configurations
 * ```typescript
 * // init — grants config:BatchGetResourceConfig
 * const batchGetResourceConfig = yield* AWS.Config.BatchGetResourceConfig();
 *
 * // runtime
 * const result = yield* batchGetResourceConfig({
 *   resourceKeys: [
 *     { resourceType: "AWS::S3::Bucket", resourceId: "my-bucket" },
 *   ],
 * });
 * console.log(result.baseConfigurationItems);
 * ```
 */
export interface BatchGetResourceConfig extends Binding.Service<
  BatchGetResourceConfig,
  "AWS.Config.BatchGetResourceConfig",
  () => Effect.Effect<
    (
      request: config.BatchGetResourceConfigRequest,
    ) => Effect.Effect<
      config.BatchGetResourceConfigResponse,
      config.BatchGetResourceConfigError
    >
  >
> {}

export const BatchGetResourceConfig = Binding.Service<BatchGetResourceConfig>(
  "AWS.Config.BatchGetResourceConfig",
);
