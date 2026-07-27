import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Amazon SageMaker delivers to EventBridge. SageMaker
 * mirrors the corresponding `Describe*` output in PascalCase; only the
 * fields shared across the state-change event kinds are declared here, the
 * rest stay open (the schema grows over time).
 */
export interface SageMakerEventDetail {
  /** Endpoint state changes: the endpoint's name. */
  EndpointName?: string;
  /** Endpoint state changes: the endpoint's status (e.g. `IN_SERVICE`, `FAILED`). */
  EndpointStatus?: string;
  /** Feature group state changes: the feature group's name. */
  FeatureGroupName?: string;
  /** Feature group state changes: the feature group's status. */
  FeatureGroupStatus?: string;
  /** Job state changes: the job's status (e.g. `Completed`, `Failed`). */
  TrainingJobStatus?: string;
  ProcessingJobStatus?: string;
  TransformJobStatus?: string;
  /** Failure detail accompanying `Failed` statuses. */
  FailureReason?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A SageMaker EventBridge event delivered to the handler. */
export type SageMakerEvent = EventRecord<SageMakerEventDetail>;

/** Which SageMaker notifications to subscribe to. */
export type SageMakerEventKind =
  | "endpoint"
  | "endpoint-deployment"
  | "feature-group"
  | "model-package"
  | "training-job"
  | "processing-job"
  | "transform-job"
  | "hyperparameter-tuning-job"
  | "pipeline-execution"
  | "pipeline-step"
  | "image";

const DETAIL_TYPES: Record<SageMakerEventKind, string> = {
  endpoint: "SageMaker Endpoint State Change",
  "endpoint-deployment": "SageMaker Endpoint Deployment State Change",
  "feature-group": "SageMaker Feature Group State Change",
  "model-package": "SageMaker Model Package State Change",
  "training-job": "SageMaker Training Job State Change",
  "processing-job": "SageMaker Processing Job State Change",
  "transform-job": "SageMaker Transform Job State Change",
  "hyperparameter-tuning-job":
    "SageMaker HyperParameter Tuning Job State Change",
  "pipeline-execution":
    "SageMaker Model Building Pipeline Execution Status Change",
  "pipeline-step":
    "SageMaker Model Building Pipeline Execution Step Status Change",
  image: "SageMaker Image State Change",
};

export interface SageMakerEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "SageMakerEvents"
   */
  id?: string;
  /**
   * Which SageMaker notifications to subscribe to: endpoint / endpoint
   * deployment / feature group / model package state changes and the
   * training, processing, transform, tuning, pipeline, and image job
   * lifecycles.
   * @default ["endpoint"]
   */
  kinds?: readonly SageMakerEventKind[];
  /**
   * Restrict to events about specific SageMaker resources (matched against
   * the event's top-level `resources`, which carries the resource ARN).
   */
  resourceArns?: readonly string[];
}

/**
 * Event source connecting Amazon SageMaker state changes to the hosting
 * compute. SageMaker publishes endpoint, feature-group, model-package, and
 * job lifecycle transitions to the account's default EventBridge bus
 * (source `aws.sagemaker`); this subscribes the host Function to those
 * events so it can react — e.g. alert when an endpoint drops out of
 * `InService` or kick off downstream work when a training job completes.
 *
 * SageMaker publishes to EventBridge automatically — no additional resource
 * is created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming SageMaker Events
 * @example Alert When an Endpoint Fails
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.SageMaker.consumeSageMakerEvents(
 *       { kinds: ["endpoint"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail.EndpointStatus === "FAILED"
 *             ? Effect.logError(
 *                 `endpoint ${event.detail.EndpointName} failed: ${event.detail.FailureReason}`,
 *               )
 *             : Effect.void,
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeSageMakerEvents = <StreamReq = never, Req = never>(
  props: SageMakerEventSourceProps,
  process: (
    events: Stream.Stream<SageMakerEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "SageMakerEvents",
    {
      source: ["aws.sagemaker"],
      "detail-type": (props.kinds ?? (["endpoint"] as const)).map(
        (kind) => DETAIL_TYPES[kind],
      ),
      ...(props.resourceArns !== undefined
        ? { resources: [...props.resourceArns] }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
