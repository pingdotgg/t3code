import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Amazon QuickSight delivers to EventBridge when an
 * asset (dashboard, analysis, dataset, data source, template, theme, folder)
 * is created, updated, or deleted. Detail-types are strings like
 * `QuickSight Dashboard Creation Successful` or
 * `QuickSight Dataset Update Failed`. Which fields are present depends on
 * the asset kind, so everything is optional.
 */
export interface QuickSightAssetEventDetail {
  /** The account the asset lives in. */
  awsAccountId?: string;
  /** Id of the affected asset (e.g. the dashboard or dataset id). */
  resourceId?: string;
  /** ARN of the affected asset. */
  arn?: string;
  /** Display name of the affected asset. */
  name?: string;
  /** Version number for versioned assets (dashboards, templates, themes). */
  versionNumber?: number;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A QuickSight asset EventBridge event delivered to the handler. */
export type QuickSightAssetEvent = EventRecord<QuickSightAssetEventDetail>;

export interface AssetEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "QuickSightAssetEvents"
   */
  id?: string;
  /**
   * Only deliver events with these `detail-type` values (e.g.
   * `["QuickSight Dashboard Creation Successful"]`).
   * @default all asset CUD events (CloudTrail service events excluded)
   */
  detailTypes?: readonly string[];
}

/**
 * Event source connecting Amazon QuickSight asset events to the hosting
 * compute. QuickSight (Enterprise Edition) publishes create/update/delete
 * outcomes for dashboards, analyses, datasets, data sources, templates,
 * themes, and folders to the account's default EventBridge bus (source
 * `aws.quicksight`, detail-types like `QuickSight Dashboard Creation
 * Successful`); this subscribes the host Function to those events so it can
 * drive continuous-deployment, replication, or backup automation.
 *
 * QuickSight publishes to EventBridge automatically — no additional resource
 * is created besides the EventBridge rule targeting the host. When
 * `detailTypes` is omitted, the rule excludes `AWS Service Event via
 * CloudTrail` so only the native asset events are delivered. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Asset Events
 * @example React To Dashboard Publishes
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default DashboardReactor.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.QuickSight.consumeAssetEvents(
 *       {
 *         detailTypes: [
 *           "QuickSight Dashboard Creation Successful",
 *           "QuickSight Dashboard Update Successful",
 *         ],
 *       },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(`dashboard ${event.detail.resourceId} published`),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeAssetEvents = <StreamReq = never, Req = never>(
  props: AssetEventSourceProps,
  process: (
    events: Stream.Stream<QuickSightAssetEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "QuickSightAssetEvents",
    {
      source: ["aws.quicksight"],
      "detail-type": props.detailTypes
        ? [...props.detailTypes]
        : [{ "anything-but": ["AWS Service Event via CloudTrail"] }],
    },
    { description: props.description, state: props.state },
    process,
  );
