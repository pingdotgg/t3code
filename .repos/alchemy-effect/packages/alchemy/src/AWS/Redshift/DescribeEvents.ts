import type * as redshift from "@distilled.cloud/aws/redshift";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeEvents` operation (IAM action
 * `redshift:DescribeEvents`).
 *
 * Lists recent events (maintenance, resizes, snapshots, security changes)
 * for the account's Redshift clusters and related resources over the last 14
 * days — the audit trail for operational tooling. For push delivery of the
 * same events see {@link EventSubscription}. Provide the implementation with
 * `Effect.provide(AWS.Redshift.DescribeEventsHttp)`.
 * @binding
 * @section Monitoring Clusters
 * @example List a Cluster's Recent Events
 * ```typescript
 * const describeEvents = yield* AWS.Redshift.DescribeEvents();
 *
 * const page = yield* describeEvents({
 *   SourceIdentifier: clusterId,
 *   SourceType: "cluster",
 * });
 * const messages = page.Events?.map((e) => e.Message);
 * ```
 */
export interface DescribeEvents extends Binding.Service<
  DescribeEvents,
  "AWS.Redshift.DescribeEvents",
  () => Effect.Effect<
    (
      request?: redshift.DescribeEventsMessage,
    ) => Effect.Effect<redshift.EventsMessage, redshift.DescribeEventsError>
  >
> {}
export const DescribeEvents = Binding.Service<DescribeEvents>(
  "AWS.Redshift.DescribeEvents",
);
