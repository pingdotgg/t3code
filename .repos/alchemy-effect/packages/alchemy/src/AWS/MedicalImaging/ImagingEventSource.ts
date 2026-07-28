import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload AWS HealthImaging delivers to EventBridge. Which
 * fields are present depends on the event kind — import job events carry
 * `jobId`/`jobStatus`, image set events carry
 * `imageSetId`/`imageSetState`/`imageSetWorkflowStatus`, data store events
 * carry only the data store fields — so everything event-specific is
 * optional.
 */
export interface MedicalImagingEventDetail {
  /** Id of the data store the event originates from. */
  datastoreId?: string;
  /** Data store lifecycle status on `Data Store …` events. */
  datastoreStatus?: string;
  /** Import job id on `Import Job …` events. */
  jobId?: string;
  /** Import job status (`SUBMITTED`, `IN_PROGRESS`, `COMPLETED`, `FAILED`). */
  jobStatus?: string;
  /** Image set id on `Image Set …` events. */
  imageSetId?: string;
  /** Image set state (`ACTIVE`, `LOCKED`, `DELETED`). */
  imageSetState?: string;
  /** Image set workflow status (`CREATED`, `COPIED`, `UPDATED`, …). */
  imageSetWorkflowStatus?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A HealthImaging EventBridge event delivered to the handler. */
export type MedicalImagingEvent = EventRecord<MedicalImagingEventDetail>;

export interface ImagingEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "MedicalImagingEvents"
   */
  id?: string;
  /**
   * Only deliver events with these `detail-type` values, e.g.
   * `["Import Job Completed", "Import Job Failed"]`. HealthImaging publishes
   * `Data Store Creating|Created|Creation Failed|Deleting|Deleted`,
   * `Import Job Submitted|In Progress|Completed|Failed`, and
   * `Image Set Created|Copying|Copying With Read Only Access|Copied|Copy
   * Failed|Updating|Updated|Update Failed|Deleting|Deleted`.
   * @default all detail types
   */
  detailTypes?: readonly string[];
  /**
   * Restrict to events from specific data stores (matched against the event
   * detail's `datastoreId`).
   * @default all data stores
   */
  datastoreIds?: readonly string[];
}

/**
 * Event source connecting AWS HealthImaging state changes to the hosting
 * compute. HealthImaging publishes data store lifecycle transitions, DICOM
 * import job progress, and image set workflow changes to the account's
 * default EventBridge bus (source `aws.medical-imaging`); this subscribes
 * the host Function to those events so it can chain post-import processing
 * (e.g. read the new image sets with `SearchImageSets` +
 * `GetImageSetMetadata`) or alert on failures.
 *
 * HealthImaging publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming HealthImaging Events
 * @example React To Finished Imports
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default ImportReactor.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.MedicalImaging.consumeImagingEvents(
 *       { detailTypes: ["Import Job Completed", "Import Job Failed"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event["detail-type"] === "Import Job Failed"
 *             ? Effect.logError(`import ${event.detail.jobId} failed`)
 *             : Effect.log(`import ${event.detail.jobId} completed`),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeImagingEvents = <StreamReq = never, Req = never>(
  props: ImagingEventSourceProps,
  process: (
    events: Stream.Stream<MedicalImagingEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "MedicalImagingEvents",
    {
      source: ["aws.medical-imaging"],
      ...(props.detailTypes !== undefined
        ? { "detail-type": [...props.detailTypes] }
        : {}),
      ...(props.datastoreIds !== undefined
        ? { detail: { datastoreId: [...props.datastoreIds] } }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
