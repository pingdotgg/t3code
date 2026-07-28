import type * as elasticache from "@distilled.cloud/aws/elasticache";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeEvents` operation (IAM action
 * `elasticache:DescribeEvents`).
 *
 * Returns events related to caches, replication groups, security groups, and
 * parameter groups from the last hour (up to 14 days with an explicit time
 * window) — snapshot completions, failovers, configuration changes. Provide
 * the implementation with `Effect.provide(AWS.ElastiCache.DescribeEventsHttp)`.
 * @binding
 * @section Monitoring Caches
 * @example Read a Cache's Recent Events
 * ```typescript
 * const describeEvents = yield* ElastiCache.DescribeEvents();
 *
 * const page = yield* describeEvents({
 *   SourceIdentifier: cacheName,
 *   SourceType: "serverless-cache",
 * });
 * for (const event of page.Events ?? []) {
 *   yield* Effect.logInfo(`${event.Date}: ${event.Message}`);
 * }
 * ```
 */
export interface DescribeEvents extends Binding.Service<
  DescribeEvents,
  "AWS.ElastiCache.DescribeEvents",
  () => Effect.Effect<
    (
      request?: elasticache.DescribeEventsMessage,
    ) => Effect.Effect<
      elasticache.EventsMessage,
      elasticache.DescribeEventsError
    >
  >
> {}
export const DescribeEvents = Binding.Service<DescribeEvents>(
  "AWS.ElastiCache.DescribeEvents",
);
