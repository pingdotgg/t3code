import type * as aas from "@distilled.cloud/aws/application-auto-scaling";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
} from "../EventBridge/EventSource.ts";
import type { ScalableTarget } from "./ScalableTarget.ts";

/**
 * The `detail` payload Application Auto Scaling delivers to EventBridge for a
 * `Application Auto Scaling Scaling Activity State Change` event. Emitted
 * when a scale-out reaches the scalable target's maximum capacity
 * (`scaledToMax: true`) — further demand cannot be absorbed until the
 * target's `maxCapacity` is raised.
 */
export interface ScalingActivityEventDetail {
  /**
   * ISO-8601 time the scaling activity started.
   */
  startTime: string;
  /**
   * ISO-8601 time the scaling activity ended.
   */
  endTime: string;
  /**
   * Desired capacity after the scaling activity.
   */
  newDesiredCapacity: number;
  /**
   * Desired capacity before the scaling activity.
   */
  oldDesiredCapacity: number;
  /**
   * Minimum capacity of the scalable target.
   */
  minCapacity: number;
  /**
   * Maximum capacity of the scalable target.
   */
  maxCapacity: number;
  /**
   * Identifier of the scaled resource, e.g. `table/my-table`.
   */
  resourceId: string;
  /**
   * Scalable dimension of the target, e.g.
   * `dynamodb:table:WriteCapacityUnits`.
   */
  scalableDimension: aas.ScalableDimension;
  /**
   * Namespace of the AWS service that provides the resource, e.g. `dynamodb`.
   */
  serviceNamespace: aas.ServiceNamespace;
  /**
   * Final status of the scaling activity (e.g. `Successful`).
   */
  statusCode: aas.ScalingActivityStatusCode;
  /**
   * Whether the activity scaled the target out to its maximum size limit.
   */
  scaledToMax: boolean;
  /**
   * Direction of the scaling activity (`scale-out` or `scale-in`).
   */
  direction?: string;
}

/** A scaling-activity EventBridge event delivered to the handler. */
export type ScalingActivityEvent = EventRecord<ScalingActivityEventDetail>;

export interface ScalingActivityEventSourceProps {
  /**
   * Logical id prefix for the EventBridge rule. Defaults to the scalable
   * target's logical id.
   */
  id?: string;
}

/**
 * Deliver Application Auto Scaling scaling-activity state-change events to
 * the host Function via EventBridge. Application Auto Scaling emits these
 * events when a scale-out pins a scalable target at its maximum capacity
 * (`detail.scaledToMax`), e.g. to alert that demand exceeds the configured
 * ceiling or to raise `maxCapacity` automatically.
 *
 * The EventBridge pattern matches every scaling-activity event in the
 * account; inspect `event.detail.resourceId` / `event.detail.serviceNamespace`
 * in the handler if multiple targets share the Function.
 *
 * @section Reacting to Scaling Activity
 * @example Alert When a Target Is Pinned at Max Capacity
 * ```typescript
 * yield* consumeScalingActivityEvents(target, {}, (events) =>
 *   Stream.runForEach(events, (event) =>
 *     event.detail.scaledToMax
 *       ? Effect.log(
 *           `${event.detail.resourceId} is pinned at max capacity ${event.detail.maxCapacity}`,
 *         )
 *       : Effect.void,
 *   ),
 * );
 * ```
 */
export const consumeScalingActivityEvents = <StreamReq = never, Req = never>(
  target: ScalableTarget,
  props: ScalingActivityEventSourceProps,
  process: (
    events: Stream.Stream<ScalingActivityEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  // The pattern uses only literal `source` + `detail-type` so it round-trips
  // through both the deploy-time rule and the runtime matcher (Output values
  // cannot appear in the pattern — they don't resolve inside the deployed
  // bundle).
  consumeBusEvents(
    `${props.id ?? target.LogicalId}-ScalingActivityEvents`,
    {
      source: ["aws.application-autoscaling"],
      "detail-type": ["Application Auto Scaling Scaling Activity State Change"],
    },
    process,
  );
