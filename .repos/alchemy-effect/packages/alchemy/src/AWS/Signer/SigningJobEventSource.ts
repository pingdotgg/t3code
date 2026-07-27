import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload AWS Signer delivers to EventBridge for a signing-job
 * status change. Fields not shared by every event kind are optional (the
 * schema grows over time).
 */
export interface SigningJobEventDetail {
  /** The signing job's new status (`Started`, `Succeeded`, `Failed`). */
  status?: string;
  /** The id of the signing job. */
  job_id?: string;
  /** The ARN of the ACM certificate used, for certificate-based platforms. */
  certificate_arn?: string;
  /** The signing platform id. */
  platform?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A Signer EventBridge event delivered to the handler. */
export type SigningJobEvent = EventRecord<SigningJobEventDetail>;

export interface SigningJobEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "SignerJobEvents"
   */
  id?: string;
  /**
   * Restrict to jobs reaching specific statuses (`Started`, `Succeeded`,
   * `Failed`). Omit to receive every status change.
   */
  statuses?: readonly string[];
}

/**
 * Event source connecting AWS Signer notifications to the hosting compute.
 * Signer publishes signing-job status changes to the account's default
 * EventBridge bus (source `aws.signer`, detail-type `Signer Job Status
 * Change`); this subscribes the host Function to those events so it can
 * react when a code-signing job starts, succeeds, or fails.
 *
 * Signer publishes to EventBridge automatically — no additional resource is
 * created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Signing Job Events
 * @example React When Signing Fails
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.Signer.consumeSigningJobEvents(
 *       { statuses: ["Failed"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.logError(`signing job ${event.detail.job_id} failed`),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeSigningJobEvents = <StreamReq = never, Req = never>(
  props: SigningJobEventSourceProps,
  process: (
    events: Stream.Stream<SigningJobEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "SignerJobEvents",
    {
      source: ["aws.signer"],
      "detail-type": ["Signer Job Status Change"],
      ...(props.statuses !== undefined
        ? { detail: { status: [...props.statuses] } }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
