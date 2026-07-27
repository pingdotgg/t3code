import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload AWS Elemental MediaConvert delivers to EventBridge
 * when a transcode job changes state (`MediaConvert Job State Change`).
 * Which fields are present depends on the event `status` (e.g.
 * `outputGroupDetails` only on `COMPLETE`, `errorCode`/`errorMessage` only
 * on `ERROR`), so everything event-specific is optional.
 */
export interface MediaConvertJobEventDetail {
  /** The job's id (`arn:…:jobs/{id}`). */
  jobId?: string;
  /** The event kind within the state change stream: `SUBMITTED`, `PROGRESSING`, `INPUT_INFORMATION`, `STATUS_UPDATE`, `NEW_WARNING`, `QUEUE_HOP`, `COMPLETE`, `ERROR`, or `CANCELED`. */
  status?: string;
  /** Timestamp (epoch millis) the event was emitted. */
  timestamp?: number;
  /** The account the job ran in. */
  accountId?: string;
  /** ARN of the queue the job ran in. */
  queue?: string;
  /** The `userMetadata` key/value pairs supplied at job submission. */
  userMetadata?: Record<string, string>;
  /** Per-output-group details (output file paths, durations) on `COMPLETE`. */
  outputGroupDetails?: unknown[];
  /** Integer error code on `ERROR` events. */
  errorCode?: number;
  /** Human-readable error message on `ERROR` events. */
  errorMessage?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A MediaConvert EventBridge event delivered to the handler. */
export type MediaConvertJobEvent = EventRecord<MediaConvertJobEventDetail>;

export interface JobEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "MediaConvertJobEvents"
   */
  id?: string;
  /**
   * Only deliver events with these `detail.status` values (e.g.
   * `["COMPLETE", "ERROR"]`).
   * @default all statuses
   */
  statuses?: readonly string[];
}

/**
 * Event source connecting AWS Elemental MediaConvert job state changes to
 * the hosting compute. MediaConvert publishes every job state transition
 * (`MediaConvert Job State Change`, source `aws.mediaconvert`) to the
 * account's default EventBridge bus; this subscribes the host Function to
 * those events so it can chain post-transcode automation or alert on
 * `ERROR` jobs.
 *
 * MediaConvert publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Job Events
 * @example React To Finished Transcodes
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default TranscodeReactor.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.MediaConvert.consumeJobEvents(
 *       { statuses: ["COMPLETE", "ERROR"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail.status === "ERROR"
 *             ? Effect.log(`job ${event.detail.jobId} failed: ${event.detail.errorMessage}`)
 *             : Effect.log(`job ${event.detail.jobId} complete`),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeJobEvents = <StreamReq = never, Req = never>(
  props: JobEventSourceProps,
  process: (
    events: Stream.Stream<MediaConvertJobEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "MediaConvertJobEvents",
    {
      source: ["aws.mediaconvert"],
      "detail-type": ["MediaConvert Job State Change"],
      ...(props.statuses ? { detail: { status: [...props.statuses] } } : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
