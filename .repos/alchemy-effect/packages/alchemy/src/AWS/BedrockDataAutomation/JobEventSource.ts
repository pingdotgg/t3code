import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Bedrock Data Automation delivers to EventBridge when
 * an asynchronous job changes state. Emitted only for jobs invoked with
 * `notificationConfiguration.eventBridgeConfiguration.eventBridgeEnabled`.
 */
export interface DataAutomationJobEventDetail {
  /** The job id (the trailing segment of the invocation ARN). */
  job_id?: string;
  /** The job status, e.g. `SUCCESS`, `CLIENT_ERROR`, `SERVICE_ERROR`. */
  job_status?: string;
  /** The detected modality, e.g. `Document`, `Image`, `Audio`, `Video`. */
  semantic_modality?: string;
  /** The S3 input object the job processed. */
  input_s3_object?: { s3_bucket?: string; name?: string };
  /** The S3 location the job wrote results to. */
  output_s3_location?: { s3_bucket?: string; name?: string };
  /** The error message for failed jobs (empty on success). */
  error_message?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A Bedrock Data Automation EventBridge event delivered to the handler. */
export type DataAutomationJobEvent = EventRecord<DataAutomationJobEventDetail>;

/** Which Bedrock Data Automation job state-change events to subscribe to. */
export type DataAutomationJobEventKind =
  | "created"
  | "succeeded"
  | "client-error"
  | "service-error";

const DETAIL_TYPES: Record<DataAutomationJobEventKind, string> = {
  created: "Bedrock Data Automation Job Created",
  succeeded: "Bedrock Data Automation Job Succeeded",
  "client-error": "Bedrock Data Automation Job Failed With Client Error",
  "service-error": "Bedrock Data Automation Job Failed With Service Error",
};

export interface DataAutomationJobEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "DataAutomationJobEvents"
   */
  id?: string;
  /**
   * Which job state-change events to subscribe to.
   * @default all kinds
   */
  kinds?: readonly DataAutomationJobEventKind[];
}

/**
 * Event source connecting Bedrock Data Automation job state changes to the
 * hosting compute. Jobs started via `InvokeDataAutomationAsync` with
 * `notificationConfiguration.eventBridgeConfiguration.eventBridgeEnabled`
 * publish created / succeeded / failed events to the account's default
 * EventBridge bus (source `aws.bedrock`); this subscribes the host Function
 * to those events so it can pick up results the moment a job settles.
 *
 * Bedrock publishes to EventBridge directly — no additional resource is
 * created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Job Events
 * @example Process Results When A Job Succeeds
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default ResultsFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.BedrockDataAutomation.consumeDataAutomationJobEvents(
 *       { kinds: ["succeeded", "client-error", "service-error"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail.job_status === "SUCCESS"
 *             ? Effect.log(
 *                 `job ${event.detail.job_id} wrote ${event.detail.output_s3_location?.name}`,
 *               )
 *             : Effect.log(`job failed: ${event.detail.error_message}`),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeDataAutomationJobEvents = <StreamReq = never, Req = never>(
  props: DataAutomationJobEventSourceProps,
  process: (
    events: Stream.Stream<DataAutomationJobEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "DataAutomationJobEvents",
    {
      source: ["aws.bedrock"],
      "detail-type": (
        props.kinds ??
        (Object.keys(DETAIL_TYPES) as DataAutomationJobEventKind[])
      ).map((kind) => DETAIL_TYPES[kind]),
    },
    { description: props.description, state: props.state },
    process,
  );
