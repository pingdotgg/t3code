import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/** S3 object attributes attached to B2BI EventBridge event details. */
export interface TransformationFileS3Attributes {
  /** The bucket containing the object. */
  bucket?: string;
  /** The object's key. */
  "object-key"?: string;
  /** The object's size in bytes. */
  "object-size-bytes"?: number;
}

/**
 * The `detail` payload B2BI delivers to EventBridge when a transformation
 * finishes (`Transformation Completed` / `Transformation Failed`). Split
 * transformations additionally carry `split-attributes`.
 */
export interface TransformationEventDetail {
  /** The system-generated identifier of the transformer run. */
  "transformer-job-id"?: string;
  /** The system-generated identifier of the trading partner. */
  "trading-partner-id"?: string;
  /** When the transformation began processing. */
  "start-timestamp"?: string;
  /** When the transformation finished processing. */
  "end-timestamp"?: string;
  /** The X12 transaction set of the document, e.g. `X12_850`. */
  "x12-transaction-set"?: string;
  /** The X12 version of the document, e.g. `VERSION_4010`. */
  "x12-version"?: string;
  /** Location and size of the input file. */
  "input-file-s3-attributes"?: TransformationFileS3Attributes;
  /** Location and size of the output file. */
  "output-file-s3-attributes"?: TransformationFileS3Attributes;
  /** For failed transformations, why the transformation failed. */
  "failure-message"?: string;
  /** For failed transformations, the failure reason code. */
  "failure-code"?: string;
  /**
   * Status of acknowledgement generation (`NOT_ATTEMPTED`, `COMPLETED`, or
   * `FAILED`); only populated when the transformation generates one.
   */
  "ack-generation-status"?: string;
  /** Whether an error code was detected while generating the acknowledgement. */
  "ack-error-code-detected"?: boolean;
  /** Source format (`JSON` or `XML`); outbound transformations only. */
  "input-format"?: string;
  /** Output format (`X12`); outbound transformations only. */
  "output-format"?: string;
  /** Validation outcome: `SUCCEEDED`, `FAILED`, or `NOT_ATTEMPTED`. */
  "validation-status"?: string;
  /** Where the validation report is stored in S3. */
  "validation-report-s3-location"?: {
    bucket?: string;
    "object-key"?: string;
  };
  /** Split-file details; only present for split transformations. */
  "split-attributes"?: {
    /** 1-indexed number of this split. */
    "split-number"?: number;
    /** Total number of splits. */
    "total-split-count"?: number;
    /** Whether this split is valid per the X12 standard. */
    "split-is-valid"?: boolean;
  };
}

/**
 * The `detail` payload B2BI delivers to EventBridge when acknowledgement
 * generation finishes (`Acknowledgement Completed` / `Acknowledgement
 * Failed`).
 */
export interface AcknowledgementEventDetail {
  /** The system-generated identifier of the transformer run. */
  "transformer-job-id"?: string;
  /** The system-generated identifier of the trading partner. */
  "trading-partner-id"?: string;
  /** When the acknowledgement began processing. */
  "start-timestamp"?: string;
  /** When the acknowledgement finished processing. */
  "end-timestamp"?: string;
  /** The X12 transaction set of the input file. */
  "input-x12-transaction-set"?: string;
  /** The X12 version of the input file. */
  "input-x12-version"?: string;
  /** Location and size of the input file. */
  "input-file-s3-attributes"?: TransformationFileS3Attributes;
  /** X12 type of the acknowledgement, e.g. `997`. */
  "ack-x12-type"?: string;
  /** X12 version of the acknowledgement. */
  "ack-x12-version"?: string;
  /** Location and size of the acknowledgement file (completed events only). */
  "ack-file-s3-attributes"?: TransformationFileS3Attributes;
  /** Whether an error code was detected (completed events only). */
  "ack-error-code-detected"?: boolean;
  /** For failed acknowledgements, why the acknowledgement failed. */
  "failure-message"?: string;
  /** For failed acknowledgements, the failure reason code. */
  "failure-code"?: string;
}

/** A transformation EventBridge event delivered to the handler. */
export type TransformationEvent = EventRecord<TransformationEventDetail>;

/** An acknowledgement EventBridge event delivered to the handler. */
export type AcknowledgementEvent = EventRecord<AcknowledgementEventDetail>;

export type TransformationEventType =
  | "Transformation Completed"
  | "Transformation Failed";

export type AcknowledgementEventType =
  | "Acknowledgement Completed"
  | "Acknowledgement Failed";

export interface TransformationEventSourceProps extends EventRouteProps {
  /**
   * Logical id prefix for the backing EventBridge rule.
   * @default "B2BI"
   */
  id?: string;
  /**
   * Only deliver these event types.
   * @default both `Transformation Completed` and `Transformation Failed`
   */
  events?: TransformationEventType[];
}

export interface AcknowledgementEventSourceProps extends EventRouteProps {
  /**
   * Logical id prefix for the backing EventBridge rule.
   * @default "B2BI"
   */
  id?: string;
  /**
   * Only deliver these event types.
   * @default both `Acknowledgement Completed` and `Acknowledgement Failed`
   */
  events?: AcknowledgementEventType[];
}

/**
 * Deliver B2BI transformation results (`aws.b2bi` / `"Transformation
 * Completed"` and `"Transformation Failed"` EventBridge events) to the host
 * Function — B2BI emits one for every transformer run, whether started by a
 * capability's S3 trigger or {@link StartTransformerJob}.
 *
 * The EventBridge pattern matches every transformation in the account and
 * region (the pattern must be literal — `Output` values do not resolve
 * inside the deployed bundle); inspect `event.detail["trading-partner-id"]`
 * or the resource ARNs in `event.resources` in the handler if multiple
 * partnerships share the Function. Provide `AWS.Lambda.EventSource` on the
 * Function effect to implement the subscription.
 *
 * @section Reacting to Transformations
 * @example Post-Process Completed Transformations
 * ```typescript
 * yield* AWS.B2BI.consumeTransformationEvents(
 *   { events: ["Transformation Completed"] },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(
 *         `transformed -> s3://${event.detail["output-file-s3-attributes"]?.bucket}/${event.detail["output-file-s3-attributes"]?.["object-key"]}`,
 *       ),
 *     ),
 * );
 * ```
 */
export const consumeTransformationEvents = <StreamReq = never, Req = never>(
  props: TransformationEventSourceProps,
  process: (
    events: Stream.Stream<TransformationEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  Effect.gen(function* () {
    const { id, events, ...routeProps } = props;

    yield* consumeBusEvents(
      `${id ?? "B2BI"}-TransformationEvents`,
      {
        source: ["aws.b2bi"],
        "detail-type":
          events && events.length > 0
            ? events
            : ["Transformation Completed", "Transformation Failed"],
      },
      routeProps,
      process,
    );
  });

/**
 * Deliver B2BI acknowledgement results (`aws.b2bi` / `"Acknowledgement
 * Completed"` and `"Acknowledgement Failed"` EventBridge events) to the host
 * Function — emitted when B2BI generates (or fails to generate) an X12
 * acknowledgement such as a 997 for an inbound document.
 *
 * Provide `AWS.Lambda.EventSource` on the Function effect to implement the
 * subscription.
 *
 * @section Reacting to Acknowledgements
 * @example Alert on Failed Acknowledgements
 * ```typescript
 * yield* AWS.B2BI.consumeAcknowledgementEvents(
 *   { events: ["Acknowledgement Failed"] },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(`ack failed: ${event.detail["failure-message"]}`),
 *     ),
 * );
 * ```
 */
export const consumeAcknowledgementEvents = <StreamReq = never, Req = never>(
  props: AcknowledgementEventSourceProps,
  process: (
    events: Stream.Stream<AcknowledgementEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  Effect.gen(function* () {
    const { id, events, ...routeProps } = props;

    yield* consumeBusEvents(
      `${id ?? "B2BI"}-AcknowledgementEvents`,
      {
        source: ["aws.b2bi"],
        "detail-type":
          events && events.length > 0
            ? events
            : ["Acknowledgement Completed", "Acknowledgement Failed"],
      },
      routeProps,
      process,
    );
  });
