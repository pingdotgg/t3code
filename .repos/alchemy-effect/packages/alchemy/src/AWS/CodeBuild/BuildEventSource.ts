import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload CodeBuild delivers to EventBridge when a build
 * changes state or completes a phase. CodeBuild uses hyphenated keys;
 * fields not shared by every event kind are optional (the schema grows
 * over time).
 */
export interface BuildEventDetail {
  /** The build's id (`{project-name}:{uuid}`). */
  "build-id"?: string;
  /** Name of the project the build belongs to. */
  "project-name"?: string;
  /**
   * State-change events: the new status — `IN_PROGRESS`, `SUCCEEDED`,
   * `FAILED`, or `STOPPED`.
   */
  "build-status"?: string;
  /** Phase-change events: the phase that just completed, e.g. `BUILD`. */
  "completed-phase"?: string;
  /** Phase-change events: the completed phase's status. */
  "completed-phase-status"?: string;
  /** Deep details: source, environment, phases, logs, … */
  "additional-information"?: Record<string, unknown>;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A CodeBuild EventBridge event delivered to the handler. */
export type BuildEvent = EventRecord<BuildEventDetail>;

/** Which CodeBuild notifications to subscribe to. */
export type BuildEventKind = "state" | "phase";

const DETAIL_TYPES: Record<BuildEventKind, string> = {
  state: "CodeBuild Build State Change",
  phase: "CodeBuild Build Phase Change",
};

export interface BuildEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "CodeBuildEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: build state changes, per-phase
   * completions, or both.
   * @default ["state"]
   */
  kinds?: readonly BuildEventKind[];
  /**
   * Restrict to events about specific projects (matched against the
   * event's `project-name`).
   */
  projectNames?: readonly string[];
}

/**
 * Event source connecting CodeBuild build notifications to the hosting
 * compute. CodeBuild publishes every build state change (and per-phase
 * completion) to the account's default EventBridge bus (source
 * `aws.codebuild`); this subscribes the host Function to those events so it
 * can alert on failed builds or chain post-build automation.
 *
 * CodeBuild publishes to EventBridge automatically — no additional resource
 * is created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Build Events
 * @example Alert On Failed Builds
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.CodeBuild.consumeBuildEvents(
 *       { kinds: ["state"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail["build-status"] === "FAILED"
 *             ? Effect.log(`build ${event.detail["build-id"]} failed`)
 *             : Effect.void,
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeBuildEvents = <StreamReq = never, Req = never>(
  props: BuildEventSourceProps,
  process: (
    events: Stream.Stream<BuildEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "CodeBuildEvents",
    {
      source: ["aws.codebuild"],
      "detail-type": (props.kinds ?? (["state"] as const)).map(
        (kind) => DETAIL_TYPES[kind],
      ),
      ...(props.projectNames !== undefined
        ? { detail: { "project-name": [...props.projectNames] } }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
