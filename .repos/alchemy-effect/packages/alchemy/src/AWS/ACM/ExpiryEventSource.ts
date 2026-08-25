import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload of an `ACM Certificate Approaching Expiration`
 * EventBridge event. ACM emits one event per day per certificate starting
 * `daysBeforeExpiry` days (see {@link AccountConfiguration}) before the
 * certificate expires. The certificate's ARN arrives in the event's
 * top-level `resources` array.
 */
export interface ExpiryEventDetail {
  /** Days remaining until the certificate expires. */
  DaysToExpiry?: number;
  /** The certificate's common name, e.g. `example.com`. */
  CommonName?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An ACM expiry EventBridge event delivered to the handler. */
export type ExpiryEvent = EventRecord<ExpiryEventDetail>;

export interface ExpiryEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "AcmExpiryEvents"
   */
  id?: string;
  /**
   * Restrict to events about specific certificates (matched against the
   * event's top-level `resources` — the certificate ARNs).
   */
  certificateArns?: readonly string[];
}

/**
 * Event source connecting ACM certificate-expiry notifications to the
 * hosting compute. ACM publishes one `ACM Certificate Approaching
 * Expiration` event per day per certificate to the account's default
 * EventBridge bus (source `aws.acm`) starting `daysBeforeExpiry` days before
 * each certificate expires — the threshold managed by the
 * {@link AccountConfiguration} resource. This subscribes the host Function
 * to those events so it can alert on, rotate, or re-import certificates
 * before they lapse.
 *
 * ACM publishes to EventBridge automatically — no additional resource is
 * created besides the EventBridge rule targeting the host. EventBridge rules
 * are regional: deploy the consuming Function in the certificate's region
 * (`us-east-1` for certificates created by the {@link Certificate}
 * resource). Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Expiry Events
 * @example Alert Before Certificates Expire
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.ACM.consumeExpiryEvents({}, (events) =>
 *       Stream.runForEach(events, (event) =>
 *         Effect.log(
 *           `${event.detail.CommonName} expires in ${event.detail.DaysToExpiry} days`,
 *         ),
 *       ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 *
 * @example Watch a Specific Certificate
 * ```typescript
 * yield* AWS.ACM.consumeExpiryEvents(
 *   { certificateArns: [certificateArn] },
 *   (events) =>
 *     Stream.runForEach(events, (event) => rotateCertificate(event)),
 * );
 * ```
 */
export const consumeExpiryEvents = <StreamReq = never, Req = never>(
  props: ExpiryEventSourceProps,
  process: (
    events: Stream.Stream<ExpiryEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "AcmExpiryEvents",
    {
      source: ["aws.acm"],
      "detail-type": ["ACM Certificate Approaching Expiration"],
      ...(props.certificateArns !== undefined
        ? { resources: [...props.certificateArns] }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
