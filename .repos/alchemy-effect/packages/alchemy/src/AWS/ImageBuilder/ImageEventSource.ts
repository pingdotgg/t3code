import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload EC2 Image Builder delivers to EventBridge.
 * Image-state-change events report the build's new state (`BUILDING`,
 * `TESTING`, `DISTRIBUTING`, `AVAILABLE`, `CANCELLED`, `FAILED`, …);
 * workflow-step-waiting events identify the `WAIT_FOR_ACTION` step that is
 * paused. Fields not shared by every event kind are optional (the schema
 * grows over time).
 */
export interface ImageEventDetail {
  /** The state the image build transitioned to (image-state-change). */
  state?: { status?: string; reason?: string };
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An Image Builder EventBridge event delivered to the handler. */
export type ImageEvent = EventRecord<ImageEventDetail>;

/** Which Image Builder notifications to subscribe to. */
export type ImageEventKind = "image-state-change" | "workflow-step-waiting";

const DETAIL_TYPES: Record<ImageEventKind, string> = {
  "image-state-change": "EC2 Image Builder Image State Change",
  "workflow-step-waiting": "EC2 Image Builder Workflow Step Waiting",
};

export interface ImageEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "ImageBuilderImageEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: image state changes (a build
   * progressing through `BUILDING` → … → `AVAILABLE`/`FAILED`/`CANCELLED`)
   * and/or workflow steps pausing on `WAIT_FOR_ACTION`.
   * @default ["image-state-change"]
   */
  kinds?: readonly ImageEventKind[];
  /**
   * Restrict to events about specific images. Matched as a prefix against
   * the event's top-level `resources`, so an image version ARN also matches
   * its build versions (`{imageVersionArn}/{build}`).
   */
  imageArns?: readonly string[];
}

/**
 * Event source connecting EC2 Image Builder notifications to the hosting
 * compute. Image Builder publishes image state changes (and workflow
 * step-waiting notifications) to the account's default EventBridge bus
 * (source `aws.imagebuilder`); this subscribes the host Function to those
 * events so it can react when a build finishes, fails, or pauses for manual
 * action.
 *
 * Image Builder publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Image Events
 * @example React When a Build Completes
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.ImageBuilder.consumeImageEvents(
 *       { kinds: ["image-state-change"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail.state?.status === "AVAILABLE"
 *             ? Effect.log(`new image ready: ${event.resources[0]}`)
 *             : Effect.log(`build ${event.detail.state?.status}`),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeImageEvents = <StreamReq = never, Req = never>(
  props: ImageEventSourceProps,
  process: (
    events: Stream.Stream<ImageEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "ImageBuilderImageEvents",
    {
      source: ["aws.imagebuilder"],
      "detail-type": (props.kinds ?? (["image-state-change"] as const)).map(
        (kind) => DETAIL_TYPES[kind],
      ),
      ...(props.imageArns !== undefined
        ? { resources: props.imageArns.map((arn) => ({ prefix: arn })) }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
