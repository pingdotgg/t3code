import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload GuardDuty delivers to EventBridge for a finding —
 * the full finding document. Only the commonly-matched fields are typed;
 * the schema grows over time.
 */
export interface FindingEventDetail {
  /** The finding id. */
  id?: string;
  /** The finding type, e.g. `Recon:EC2/PortProbeUnprotectedPort`. */
  type?: string;
  /** The finding severity (0.1–8+; 7+ is high). */
  severity?: number;
  /** The account the finding was generated in. */
  accountId?: string;
  /** The region the finding was generated in. */
  region?: string;
  /** The finding's ARN. */
  arn?: string;
  /** The finding title. */
  title?: string;
  /** The finding description. */
  description?: string;
  /** The affected resource document. */
  resource?: Record<string, unknown>;
  /** The detection service document (counts, first/last seen, …). */
  service?: Record<string, unknown>;
  /** Additional finding fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A GuardDuty finding EventBridge event delivered to the handler. */
export type FindingEvent = EventRecord<FindingEventDetail>;

export interface FindingEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "GuardDutyFindings"
   */
  id?: string;
  /**
   * Restrict to specific finding types (matched against `detail.type`),
   * e.g. `["Recon:EC2/PortProbeUnprotectedPort"]`.
   */
  types?: readonly string[];
  /**
   * Restrict to specific numeric severities (matched against
   * `detail.severity`). GuardDuty publishes updated findings at the
   * detector's `findingPublishingFrequency`, but new findings arrive
   * within about five minutes.
   */
  severities?: readonly number[];
}

/**
 * Event source connecting GuardDuty findings to the hosting compute.
 * GuardDuty publishes every new finding (and periodic updates for
 * recurring ones) to the account's default EventBridge bus (source
 * `aws.guardduty`, detail-type `GuardDuty Finding`); this subscribes the
 * host Function to those events so it can triage, notify, or auto-remediate.
 *
 * GuardDuty publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Findings
 * @example Alert on High-Severity Findings
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.GuardDuty.consumeFindings({}, (events) =>
 *       Stream.runForEach(events, (event) =>
 *         (event.detail.severity ?? 0) >= 7
 *           ? Effect.logError(
 *               `GuardDuty: ${event.detail.type} on ${event.detail.accountId}`,
 *             )
 *           : Effect.void,
 *       ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeFindings = <StreamReq = never, Req = never>(
  props: FindingEventSourceProps,
  process: (
    events: Stream.Stream<FindingEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "GuardDutyFindings",
    {
      source: ["aws.guardduty"],
      "detail-type": ["GuardDuty Finding"],
      ...(props.types !== undefined || props.severities !== undefined
        ? {
            detail: {
              ...(props.types !== undefined ? { type: [...props.types] } : {}),
              ...(props.severities !== undefined
                ? { severity: [...props.severities] }
                : {}),
            },
          }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
