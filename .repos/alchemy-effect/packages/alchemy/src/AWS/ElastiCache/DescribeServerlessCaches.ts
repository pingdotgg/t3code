import type * as elasticache from "@distilled.cloud/aws/elasticache";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeServerlessCaches` operation (IAM action
 * `elasticache:DescribeServerlessCaches`).
 *
 * Reads the current status, endpoint, and configuration of the account's
 * serverless caches — e.g. an operational health check that verifies a cache
 * is `available` before routing traffic. Provide the implementation with
 * `Effect.provide(AWS.ElastiCache.DescribeServerlessCachesHttp)`.
 * @binding
 * @section Monitoring Caches
 * @example Check a Cache's Status
 * ```typescript
 * const describeCaches = yield* ElastiCache.DescribeServerlessCaches();
 *
 * const result = yield* describeCaches({ ServerlessCacheName: name });
 * // result.ServerlessCaches?.[0]?.Status → "available"
 * ```
 */
export interface DescribeServerlessCaches extends Binding.Service<
  DescribeServerlessCaches,
  "AWS.ElastiCache.DescribeServerlessCaches",
  () => Effect.Effect<
    (
      request?: elasticache.DescribeServerlessCachesRequest,
    ) => Effect.Effect<
      elasticache.DescribeServerlessCachesResponse,
      elasticache.DescribeServerlessCachesError
    >
  >
> {}
export const DescribeServerlessCaches =
  Binding.Service<DescribeServerlessCaches>(
    "AWS.ElastiCache.DescribeServerlessCaches",
  );
