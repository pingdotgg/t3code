import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload AWS Elemental MediaPackage v2 delivers to
 * EventBridge when a live-to-VOD harvest job succeeds or fails
 * (detail-type `MediaPackageV2 HarvestJob Notification`).
 */
export interface MediaPackageV2HarvestJobEventDetail {
  /** The harvest job the notification is about. */
  harvestJob: {
    /** Name of the harvest job. */
    harvestJobName: string;
    /** ARN of the harvest job. */
    arn: string;
    /** Terminal status: `COMPLETED` or `FAILED`. */
    status: string;
    /** Channel group the harvested endpoint belongs to. */
    channelGroupName: string;
    /** Channel the harvested endpoint belongs to. */
    channelName: string;
    /** Origin endpoint the content was harvested from. */
    originEndpointName: string;
    /** Human-readable outcome (e.g. the failure reason). */
    message?: string;
    /** The harvested time window. */
    scheduleConfiguration?: { startTime?: string; endTime?: string };
    /** Where the VOD asset was written. */
    destination?: {
      s3Destination?: { bucketName?: string; destinationPath?: string };
    };
    /** Additional fields (the schema grows over time). */
    [key: string]: unknown;
  };
}

/** A MediaPackage v2 harvest-job EventBridge event delivered to the handler. */
export type MediaPackageV2HarvestJobEvent =
  EventRecord<MediaPackageV2HarvestJobEventDetail>;

export interface HarvestJobEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "MediaPackageV2HarvestJobEvents"
   */
  id?: string;
  /**
   * Restrict to notifications about specific harvest jobs (matched against
   * the event's top-level `resources`, which contains the harvest job ARN
   * `{endpointArn}/harvestJob/{name}`). Prefix patterns are not supported
   * here — filter in the handler for per-endpoint routing.
   */
  harvestJobArns?: readonly string[];
}

/**
 * Event source connecting AWS Elemental MediaPackage v2 harvest-job
 * notifications to the hosting compute. MediaPackage publishes an event to
 * the account's default EventBridge bus (source `aws.mediapackagev2`,
 * detail-type `MediaPackageV2 HarvestJob Notification`) when a live-to-VOD
 * harvest job completes or fails; this subscribes the host Function to
 * those events so it can publish the exported clip — or alert on a failed
 * export — without polling `GetHarvestJob`.
 *
 * MediaPackage publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Harvest Job Events
 * @example Publish a Clip When Its Harvest Job Completes
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default ClipPublisher.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.MediaPackageV2.consumeHarvestJobEvents({}, (events) =>
 *       Stream.runForEach(events, (event) =>
 *         event.detail.harvestJob.status === "COMPLETED"
 *           ? Effect.log(
 *               `clip ready: ${event.detail.harvestJob.destination?.s3Destination?.destinationPath}`,
 *             )
 *           : Effect.log(`harvest failed: ${event.detail.harvestJob.message}`),
 *       ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeHarvestJobEvents = <StreamReq = never, Req = never>(
  props: HarvestJobEventSourceProps,
  process: (
    events: Stream.Stream<MediaPackageV2HarvestJobEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "MediaPackageV2HarvestJobEvents",
    {
      source: ["aws.mediapackagev2"],
      "detail-type": ["MediaPackageV2 HarvestJob Notification"],
      ...(props.harvestJobArns !== undefined
        ? { resources: [...props.harvestJobArns] }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
