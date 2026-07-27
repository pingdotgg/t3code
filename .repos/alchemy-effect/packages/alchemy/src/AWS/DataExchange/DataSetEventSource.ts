import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload AWS Data Exchange delivers to EventBridge. Revision
 * events carry the published/revoked `RevisionIds`; product events carry
 * `DataSetIds`; provider-generated notifications carry the notification
 * comment and scope. Fields not shared by every event kind are optional
 * (the schema grows over time).
 */
export interface DataSetEventDetail {
  /** Revision events: the revisions that were published or revoked. */
  RevisionIds?: string[];
  /** Product events: the data sets that were added to or removed from a product. */
  DataSetIds?: string[];
  /** Revocation events: the provider's revocation comment. */
  RevocationComment?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An AWS Data Exchange EventBridge event delivered to the handler. */
export type DataSetEvent = EventRecord<DataSetEventDetail>;

/**
 * Which AWS Data Exchange notifications to subscribe to. Each kind maps to
 * one documented EventBridge detail-type (source `aws.dataexchange`).
 */
export type DataSetEventKind =
  | "revision-published"
  | "revision-revoked"
  | "data-sets-published-to-product"
  | "data-set-removed-from-product"
  | "update-delayed"
  | "data-updated"
  | "deprecation-planned"
  | "schema-change-planned"
  | "auto-export-completed"
  | "auto-export-failed"
  | "data-grant-accepted"
  | "data-grant-extended"
  | "data-grant-revoked";

const DETAIL_TYPES: Record<DataSetEventKind, string> = {
  "revision-published": "Revision Published To Data Set",
  "revision-revoked": "Revision Revoked",
  "data-sets-published-to-product": "Data Sets Published To Product",
  "data-set-removed-from-product": "Data Set Removed From Product",
  "update-delayed": "Data Set Update Delayed",
  "data-updated": "Data Updated in Data Set",
  "deprecation-planned": "Deprecation Planned for Data Set",
  "schema-change-planned": "Schema Change Planned for Data Set",
  "auto-export-completed": "Auto-export Job Completed",
  "auto-export-failed": "Auto-export Job Failed",
  "data-grant-accepted": "Data Grant Accepted",
  "data-grant-extended": "Data Grant Extended",
  "data-grant-revoked": "Data Grant Revoked",
};

export interface DataSetEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "DataExchangeEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to. Data Exchange publishes provider
   * events (new revisions, revocations, product changes), provider-generated
   * notifications (data updated/delayed, schema change, deprecation),
   * auto-export job outcomes, and data grant lifecycle events.
   * @default ["revision-published"]
   */
  kinds?: readonly DataSetEventKind[];
  /**
   * Raw EventBridge detail-types to subscribe to in addition to `kinds` —
   * the escape hatch for the long tail of asset-type-specific detail-types
   * (Redshift datashare, API Gateway API, S3 data access, Lake Formation).
   */
  detailTypes?: readonly string[];
  /**
   * Restrict to events about specific data sets (matched against the
   * event's top-level `resources`, which carries the data set id).
   */
  dataSetIds?: readonly string[];
}

/**
 * Event source connecting AWS Data Exchange notifications to the hosting
 * compute. Data Exchange publishes subscriber-facing events to the
 * account's default EventBridge bus (source `aws.dataexchange`) — most
 * importantly `Revision Published To Data Set` when a provider publishes
 * fresh data to an entitled data set — and this subscribes the host
 * Function to those events so it can trigger export jobs or downstream
 * pipelines the moment new data arrives.
 *
 * Data Exchange publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Data Exchange Events
 * @example Process Newly Published Revisions
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default IngestFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.DataExchange.consumeDataSetEvents(
 *       { kinds: ["revision-published", "revision-revoked"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(
 *             `${event["detail-type"]}: revisions ${event.detail.RevisionIds}`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeDataSetEvents = <StreamReq = never, Req = never>(
  props: DataSetEventSourceProps,
  process: (
    events: Stream.Stream<DataSetEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "DataExchangeEvents",
    {
      source: ["aws.dataexchange"],
      "detail-type": [
        ...(props.kinds ?? (["revision-published"] as const)).map(
          (kind) => DETAIL_TYPES[kind],
        ),
        ...(props.detailTypes ?? []),
      ],
      ...(props.dataSetIds !== undefined
        ? { resources: [...props.dataSetIds] }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
