import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload ECR delivers to EventBridge on every completed image
 * push or delete (`ECR Image Action`).
 */
export interface ImageActionDetail {
  /** Whether the action was a `PUSH` or a `DELETE`. */
  "action-type": "PUSH" | "DELETE";
  /** Outcome of the action (`SUCCESS` or `FAILURE`). */
  result: "SUCCESS" | "FAILURE";
  /** Name of the repository the image was pushed to / deleted from. */
  "repository-name": string;
  /** Manifest digest of the affected image, e.g. `sha256:…`. */
  "image-digest": string;
  /** Tag of the affected image, when the action targeted a tag. */
  "image-tag"?: string;
  /** Media type of the manifest, e.g. `application/vnd.docker.distribution.manifest.v2+json`. */
  "manifest-media-type"?: string;
  /** Artifact media type, for OCI artifacts. */
  "artifact-media-type"?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An ECR image action EventBridge event delivered to the handler. */
export type ImageActionEvent = EventRecord<ImageActionDetail>;

/**
 * The `detail` payload ECR delivers to EventBridge when an image scan
 * completes (`ECR Image Scan`).
 */
export interface ImageScanDetail {
  /** Status of the completed scan, e.g. `COMPLETE`. */
  "scan-status": string;
  /** Name of the repository containing the scanned image. */
  "repository-name": string;
  /** Manifest digest of the scanned image. */
  "image-digest": string;
  /** Tags of the scanned image. */
  "image-tags"?: string[];
  /** Vulnerability counts keyed by severity, e.g. `{ HIGH: 2 }`. */
  "finding-severity-counts"?: Record<string, number>;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An ECR image scan EventBridge event delivered to the handler. */
export type ImageScanEvent = EventRecord<ImageScanDetail>;

export interface ImageActionsProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "EcrImageActions"
   */
  id?: string;
  /**
   * Only deliver events for these repositories (by name).
   * @default all repositories
   */
  repositories?: string[];
  /**
   * Only deliver `PUSH` or `DELETE` actions.
   * @default both
   */
  actionTypes?: ("PUSH" | "DELETE")[];
  /**
   * Only deliver actions with these results (e.g. `["SUCCESS"]`).
   * @default both
   */
  results?: ("SUCCESS" | "FAILURE")[];
}

/**
 * Event source connecting ECR image pushes and deletes to the hosting
 * compute. ECR publishes an event to the account's default EventBridge bus
 * (source `aws.ecr`, detail-type `ECR Image Action`) every time an image
 * push or delete completes; this subscribes the host Function to those
 * events so it can react without polling.
 *
 * ECR publishes to EventBridge automatically — no additional resource is
 * created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Image Events
 * @example React to Successful Pushes
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default DeployBot.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.ECR.consumeImageActions(
 *       { actionTypes: ["PUSH"], results: ["SUCCESS"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(
 *             `${event.detail["repository-name"]}:${event.detail["image-tag"]} pushed`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeImageActions = <StreamReq = never, Req = never>(
  props: ImageActionsProps,
  process: (
    events: Stream.Stream<ImageActionEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "EcrImageActions",
    {
      source: ["aws.ecr"],
      "detail-type": ["ECR Image Action"],
      ...(props.repositories || props.actionTypes || props.results
        ? {
            detail: {
              ...(props.repositories
                ? { "repository-name": [...props.repositories] }
                : {}),
              ...(props.actionTypes
                ? { "action-type": [...props.actionTypes] }
                : {}),
              ...(props.results ? { result: [...props.results] } : {}),
            },
          }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );

export interface ImageScansProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "EcrImageScans"
   */
  id?: string;
  /**
   * Only deliver events for these repositories (by name).
   * @default all repositories
   */
  repositories?: string[];
}

/**
 * Event source connecting completed ECR image scans to the hosting compute.
 * ECR publishes an event to the account's default EventBridge bus (source
 * `aws.ecr`, detail-type `ECR Image Scan`) when a vulnerability scan
 * finishes — including scan-on-push scans; this subscribes the host Function
 * to those events so it can react to new findings without polling.
 *
 * @section Consuming Image Events
 * @example Alert on High-Severity Findings
 * ```typescript
 * yield* AWS.ECR.consumeImageScans({}, (events) =>
 *   Stream.runForEach(events, (event) =>
 *     Effect.log(
 *       event.detail["repository-name"],
 *       event.detail["finding-severity-counts"],
 *     ),
 *   ),
 * );
 * ```
 */
export const consumeImageScans = <StreamReq = never, Req = never>(
  props: ImageScansProps,
  process: (
    events: Stream.Stream<ImageScanEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "EcrImageScans",
    {
      source: ["aws.ecr"],
      "detail-type": ["ECR Image Scan"],
      ...(props.repositories
        ? { detail: { "repository-name": [...props.repositories] } }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
