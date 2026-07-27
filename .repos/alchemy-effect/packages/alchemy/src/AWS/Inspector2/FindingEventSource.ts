import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Amazon Inspector delivers to EventBridge for a
 * finding — the full finding document. Only the commonly-matched fields are
 * typed; the schema grows over time.
 */
export interface FindingEventDetail {
  /** The finding's ARN. */
  findingArn?: string;
  /** The account the finding was generated in. */
  awsAccountId?: string;
  /** The finding severity (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, ...). */
  severity?: string;
  /** The finding status (`ACTIVE`, `SUPPRESSED`, `CLOSED`). */
  status?: string;
  /** The finding type (`PACKAGE_VULNERABILITY`, `NETWORK_REACHABILITY`, `CODE_VULNERABILITY`). */
  type?: string;
  /** The finding title, e.g. `CVE-2021-44228 - log4j-core`. */
  title?: string;
  /** The finding description. */
  description?: string;
  /** The Inspector risk score. */
  inspectorScore?: number;
  /** The affected resources. */
  resources?: Array<Record<string, unknown>>;
  /** Package vulnerability details (CVE, affected packages, ...). */
  packageVulnerabilityDetails?: Record<string, unknown>;
  /** Additional finding fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An Amazon Inspector finding EventBridge event delivered to the handler. */
export type FindingEvent = EventRecord<FindingEventDetail>;

export interface FindingEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "Inspector2Findings"
   */
  id?: string;
  /**
   * Restrict to specific severities (matched against `detail.severity`),
   * e.g. `["CRITICAL", "HIGH"]`.
   */
  severities?: readonly string[];
  /**
   * Restrict to specific finding statuses (matched against
   * `detail.status`), e.g. `["ACTIVE"]`.
   */
  statuses?: readonly string[];
}

/**
 * Event source connecting Amazon Inspector findings to the hosting compute.
 * Inspector publishes every newly created, updated, or closed finding to
 * the account's default EventBridge bus (source `aws.inspector2`,
 * detail-type `Inspector2 Finding`); this subscribes the host Function to
 * those events so it can triage, notify, or auto-remediate.
 *
 * Inspector publishes to EventBridge automatically — no additional resource
 * is created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Findings
 * @example Alert on Critical Findings
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.Inspector2.consumeFindings(
 *       { severities: ["CRITICAL"], statuses: ["ACTIVE"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.logError(
 *             `Inspector: ${event.detail.title} on ${event.detail.awsAccountId}`,
 *           ),
 *         ),
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
    props.id ?? "Inspector2Findings",
    {
      source: ["aws.inspector2"],
      "detail-type": ["Inspector2 Finding"],
      ...(props.severities !== undefined || props.statuses !== undefined
        ? {
            detail: {
              ...(props.severities !== undefined
                ? { severity: [...props.severities] }
                : {}),
              ...(props.statuses !== undefined
                ? { status: [...props.statuses] }
                : {}),
            },
          }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
