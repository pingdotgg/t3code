import type * as config from "@distilled.cloud/aws/config-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `config:SelectResourceConfig` — run a SQL `SELECT`
 * query (AWS Config advanced query) against the current configuration
 * state of recorded resources.
 *
 * Provide `Config.SelectResourceConfigHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Querying with SQL
 * @example Query Resource State with SQL
 * ```typescript
 * // init — grants config:SelectResourceConfig
 * const selectResourceConfig = yield* AWS.Config.SelectResourceConfig();
 *
 * // runtime
 * const result = yield* selectResourceConfig({
 *   Expression:
 *     "SELECT resourceId WHERE resourceType = 'AWS::S3::Bucket'",
 * });
 * console.log(result.Results);
 * ```
 */
export interface SelectResourceConfig extends Binding.Service<
  SelectResourceConfig,
  "AWS.Config.SelectResourceConfig",
  () => Effect.Effect<
    (
      request: config.SelectResourceConfigRequest,
    ) => Effect.Effect<
      config.SelectResourceConfigResponse,
      config.SelectResourceConfigError
    >
  >
> {}

export const SelectResourceConfig = Binding.Service<SelectResourceConfig>(
  "AWS.Config.SelectResourceConfig",
);
