import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload EventBridge delivers for a CloudTrail-recorded API
 * call (`AWS API Call via CloudTrail`). The shape mirrors the CloudTrail
 * event record.
 */
export interface ApiCallDetail {
  /** The service endpoint the call was made to, e.g. `s3.amazonaws.com`. */
  eventSource: string;
  /** The API operation name, e.g. `PutBucketTagging`. */
  eventName: string;
  /** The region the call was made in. */
  awsRegion?: string;
  /** Unique id of the CloudTrail event record. */
  eventID?: string;
  /** ISO timestamp of the call. */
  eventTime?: string;
  /** Version of the CloudTrail event schema. */
  eventVersion?: string;
  /** Identity that made the call (IAM user, role session, service, …). */
  userIdentity?: Record<string, unknown>;
  /** The request parameters of the call, as recorded by CloudTrail. */
  requestParameters?: Record<string, any>;
  /** The response elements of the call (mutating calls only). */
  responseElements?: Record<string, any> | null;
  /** Error code when the recorded call failed. */
  errorCode?: string;
  /** Error message when the recorded call failed. */
  errorMessage?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A CloudTrail API-call EventBridge event delivered to the handler. */
export type ApiCallEvent = EventRecord<ApiCallDetail>;

export interface ApiCallEventsProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "CloudTrailApiCallEvents"
   */
  id?: string;
  /**
   * Only deliver calls made to these service endpoints (the CloudTrail
   * `eventSource`, e.g. `["s3.amazonaws.com"]`).
   * @default all services
   */
  eventSources?: string[];
  /**
   * Only deliver these API operations (the CloudTrail `eventName`, e.g.
   * `["PutBucketTagging"]`).
   * @default all operations
   */
  eventNames?: string[];
}

/**
 * Event source connecting CloudTrail-recorded API calls to the hosting
 * compute. EventBridge receives every **mutating** management API call
 * CloudTrail records (detail-type `AWS API Call via CloudTrail`) on the
 * account's default bus — read-only calls (`Get*`/`List*`/`Describe*`) and
 * data events are not delivered. This subscribes the host Function to those
 * events so it can react to control-plane changes (security automation,
 * config auditing) without polling.
 *
 * EventBridge receives these events automatically — no trail is required and
 * no additional resource is created besides the EventBridge rule targeting
 * the host. Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming API Call Events
 * @example React to S3 Bucket Configuration Changes
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AuditFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.CloudTrail.consumeApiCallEvents(
 *       {
 *         eventSources: ["s3.amazonaws.com"],
 *         eventNames: ["PutBucketPolicy", "PutBucketAcl"],
 *       },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(
 *             `${event.detail.eventName} on ${JSON.stringify(
 *               event.detail.requestParameters,
 *             )}`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeApiCallEvents = <StreamReq = never, Req = never>(
  props: ApiCallEventsProps,
  process: (
    events: Stream.Stream<ApiCallEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "CloudTrailApiCallEvents",
    {
      "detail-type": ["AWS API Call via CloudTrail"],
      ...(props.eventSources || props.eventNames
        ? {
            detail: {
              ...(props.eventSources
                ? { eventSource: [...props.eventSources] }
                : {}),
              ...(props.eventNames ? { eventName: [...props.eventNames] } : {}),
            },
          }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
