import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/** The category of a Macie finding. */
export type FindingCategory = "CLASSIFICATION" | "POLICY";

/** The qualitative severity of a Macie finding. */
export type FindingSeverityDescription = "Low" | "Medium" | "High";

/**
 * The `detail` payload Macie delivers to EventBridge for a finding — the full
 * finding document. Only the commonly-matched fields are typed; the schema
 * grows over time.
 */
export interface FindingEventDetail {
  /** The finding id. */
  id?: string;
  /** The finding type, e.g. `SensitiveData:S3Object/Personal`. */
  type?: string;
  /** Whether the finding is a sensitive-data or policy finding. */
  category?: FindingCategory;
  /** The finding severity (score 1-3 plus a qualitative description). */
  severity?: { score?: number; description?: FindingSeverityDescription };
  /** The account the finding was generated in. */
  accountId?: string;
  /** The region the finding was generated in. */
  region?: string;
  /** The finding title. */
  title?: string;
  /** The finding description. */
  description?: string;
  /** The affected resources document (S3 bucket + object details). */
  resourcesAffected?: Record<string, unknown>;
  /** For classification findings, the sensitive-data detection details. */
  classificationDetails?: Record<string, unknown>;
  /** Additional finding fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A Macie finding EventBridge event delivered to the handler. */
export type FindingEvent = EventRecord<FindingEventDetail>;

export interface FindingEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "MacieFindings"
   */
  id?: string;
  /**
   * Restrict to specific finding types (matched against `detail.type`),
   * e.g. `["SensitiveData:S3Object/Personal"]`.
   */
  types?: readonly string[];
  /**
   * Restrict to a finding category: `CLASSIFICATION` (sensitive data found in
   * an object) or `POLICY` (a bucket policy/configuration issue).
   */
  categories?: readonly FindingCategory[];
  /**
   * Restrict to qualitative severities (matched against
   * `detail.severity.description`), e.g. `["High"]`.
   */
  severities?: readonly FindingSeverityDescription[];
}

/**
 * Event source connecting Amazon Macie findings to the hosting compute.
 * Macie publishes every new finding (and periodic updates for recurring ones,
 * at the session's `findingPublishingFrequency`) to the account's default
 * EventBridge bus (source `aws.macie`, detail-type `Macie Finding`); this
 * subscribes the host Function to those events so it can triage, notify, or
 * quarantine the affected S3 objects.
 *
 * Macie publishes to EventBridge automatically — no additional resource is
 * created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Findings
 * @example Alert on High-Severity Sensitive Data
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.Macie2.consumeFindings(
 *       { categories: ["CLASSIFICATION"], severities: ["High"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.logError(
 *             `Macie: ${event.detail.type} in ${event.detail.accountId}`,
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
    props.id ?? "MacieFindings",
    {
      source: ["aws.macie"],
      "detail-type": ["Macie Finding"],
      ...(props.types !== undefined ||
      props.categories !== undefined ||
      props.severities !== undefined
        ? {
            detail: {
              ...(props.types !== undefined ? { type: [...props.types] } : {}),
              ...(props.categories !== undefined
                ? { category: [...props.categories] }
                : {}),
              ...(props.severities !== undefined
                ? { severity: { description: [...props.severities] } }
                : {}),
            },
          }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
