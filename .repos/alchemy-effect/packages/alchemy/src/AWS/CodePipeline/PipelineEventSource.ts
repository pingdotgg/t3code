import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload CodePipeline delivers to EventBridge when a pipeline,
 * stage, or action execution changes state. Fields not shared by every
 * event kind are optional (the schema grows over time).
 */
export interface PipelineEventDetail {
  /** Name of the pipeline the event belongs to. */
  pipeline?: string;
  /** Structure version of the pipeline. */
  version?: number;
  /** Id of the pipeline execution. */
  "execution-id"?: string;
  /**
   * The new state — `STARTED`, `SUCCEEDED`, `FAILED`, `CANCELED`,
   * `STOPPED`, `STOPPING`, `SUPERSEDED`, or `RESUMED`.
   */
  state?: string;
  /** Stage/action events: the stage the event belongs to. */
  stage?: string;
  /** Action events: the action the event belongs to. */
  action?: string;
  /** Pipeline events: what triggered the execution. */
  "execution-trigger"?: Record<string, unknown>;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A CodePipeline EventBridge event delivered to the handler. */
export type PipelineEvent = EventRecord<PipelineEventDetail>;

/** Which CodePipeline notifications to subscribe to. */
export type PipelineEventKind = "execution" | "stage" | "action";

const DETAIL_TYPES: Record<PipelineEventKind, string> = {
  execution: "CodePipeline Pipeline Execution State Change",
  stage: "CodePipeline Stage Execution State Change",
  action: "CodePipeline Action Execution State Change",
};

export interface PipelineEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "CodePipelineEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: pipeline-execution, stage-execution,
   * or action-execution state changes (any combination).
   * @default ["execution"]
   */
  kinds?: readonly PipelineEventKind[];
  /**
   * Restrict to events about specific pipelines (matched against the
   * event's `pipeline`).
   */
  pipelineNames?: readonly string[];
}

/**
 * Event source connecting CodePipeline execution notifications to the
 * hosting compute. CodePipeline publishes every pipeline, stage, and action
 * execution state change to the account's default EventBridge bus (source
 * `aws.codepipeline`); this subscribes the host Function to those events so
 * it can alert on failed deployments or chain post-release automation.
 *
 * CodePipeline publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Pipeline Events
 * @example Alert On Failed Executions
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.CodePipeline.consumePipelineEvents(
 *       { kinds: ["execution"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail.state === "FAILED"
 *             ? Effect.log(`pipeline ${event.detail.pipeline} failed`)
 *             : Effect.void,
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumePipelineEvents = <StreamReq = never, Req = never>(
  props: PipelineEventSourceProps,
  process: (
    events: Stream.Stream<PipelineEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "CodePipelineEvents",
    {
      source: ["aws.codepipeline"],
      "detail-type": (props.kinds ?? (["execution"] as const)).map(
        (kind) => DETAIL_TYPES[kind],
      ),
      ...(props.pipelineNames !== undefined
        ? { detail: { pipeline: [...props.pipelineNames] } }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
