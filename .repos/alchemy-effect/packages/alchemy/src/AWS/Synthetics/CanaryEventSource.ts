import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { Input } from "../../Input.ts";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The detail-types CloudWatch Synthetics publishes to EventBridge:
 * canary lifecycle transitions and per-run pass/fail results.
 */
export type CanaryEventDetailType =
  | "Synthetics Canary Status Change"
  | "Synthetics Canary TestRun Successful"
  | "Synthetics Canary TestRun Failure";

/**
 * The `detail` payload CloudWatch Synthetics delivers to EventBridge for
 * canary status changes and test-run results. Keys are hyphenated on the
 * wire; fields not shared by every detail-type are optional (the schema
 * grows over time).
 */
export interface CanaryEventDetail {
  /** The account the canary lives in. */
  "account-id"?: string;
  /** Service-assigned unique ID of the canary. */
  "canary-id"?: string;
  /** Name of the canary the event is about. */
  "canary-name"?: string;
  /** Status-change events: the canary's new state (e.g. `RUNNING`). */
  "current-state"?: string;
  /** Status-change events: the canary's previous state. */
  "previous-state"?: string;
  /** Test-run events: the run result (`PASSED`, `FAILED`). */
  "test-run-status"?: string;
  /** Test-run events: the id of the canary run. */
  "canary-run-id"?: string;
  /** S3 location of the run's artifacts. */
  "artifact-location"?: string;
  /** Human-readable reason for the state, when present. */
  "state-reason"?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A Synthetics canary event delivered to the handler. */
export type CanaryEventRecord = EventRecord<CanaryEventDetail>;

export interface CanaryEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "SyntheticsCanaryEvents"
   */
  id?: string;
  /**
   * Restrict to events emitted by the given canaries (matched against the
   * event detail's `canary-name`). Pass `canary.canaryName`.
   * @default all canaries in the account
   */
  canaryNames?: readonly Input<string>[];
  /**
   * Restrict to the given detail-types (status changes and/or test-run
   * results).
   * @default all three Synthetics detail-types
   */
  detailTypes?: readonly CanaryEventDetailType[];
}

/**
 * Event source connecting CloudWatch Synthetics canary events to the
 * hosting compute. Synthetics publishes canary status changes and per-run
 * pass/fail results to the account's default EventBridge bus (source
 * `aws.synthetics`); this subscribes the host Function to those events so
 * it can page on failed runs, annotate deploy dashboards, or kick off
 * remediation.
 *
 * Synthetics publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Canary Events
 * @example Page on Failed Canary Runs
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const canary = yield* AWS.Synthetics.Canary("ApiMonitor", {
 *       script: canaryScript,
 *       artifactS3Location: artifactLocation,
 *       start: true,
 *     });
 *
 *     yield* AWS.Synthetics.consumeCanaryEvents(
 *       {
 *         canaryNames: [canary.canaryName],
 *         detailTypes: ["Synthetics Canary TestRun Failure"],
 *       },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.logError(
 *             `canary ${event.detail["canary-name"]} run failed`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeCanaryEvents = <StreamReq = never, Req = never>(
  props: CanaryEventSourceProps,
  process: (
    events: Stream.Stream<CanaryEventRecord, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "SyntheticsCanaryEvents",
    {
      source: ["aws.synthetics"],
      "detail-type": [
        ...(props.detailTypes ?? [
          "Synthetics Canary Status Change",
          "Synthetics Canary TestRun Successful",
          "Synthetics Canary TestRun Failure",
        ]),
      ],
      ...(props.canaryNames !== undefined
        ? { detail: { "canary-name": [...props.canaryNames] } }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
