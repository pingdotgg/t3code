import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload IoT Greengrass V2 delivers to EventBridge.
 * Deployment-status events describe a deployment landing on a core device
 * (`deploymentId`, `coreDeviceExecutionStatus`); component-status events
 * describe an installed component's lifecycle state (`componentName`,
 * `componentLifecycleState`, e.g. `BROKEN`). Fields not shared by every
 * event kind are optional (the schema grows over time).
 */
export interface GreengrassEventDetail {
  /** The core device thing name the event is about. */
  coreDeviceThingName?: string;
  /** Deployment-status events: the id of the deployment. */
  deploymentId?: string;
  /**
   * Deployment-status events: the per-device execution status, e.g.
   * `SUCCEEDED`, `FAILED`, `REJECTED`, `TIMED_OUT`.
   */
  coreDeviceExecutionStatus?: string;
  /** Component-status events: the name of the installed component. */
  componentName?: string;
  /** Component-status events: the version of the installed component. */
  componentVersion?: string;
  /**
   * Component-status events: the component's lifecycle state, e.g.
   * `RUNNING`, `ERRORED`, `BROKEN`.
   */
  componentLifecycleState?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An IoT Greengrass V2 EventBridge event delivered to the handler. */
export type GreengrassEvent = EventRecord<GreengrassEventDetail>;

/** Which IoT Greengrass V2 notifications to subscribe to. */
export type GreengrassEventKind = "deployment-status" | "component-status";

const DETAIL_TYPES: Record<GreengrassEventKind, string> = {
  "deployment-status": "Greengrass V2 Effective Deployment Status Change",
  "component-status": "Greengrass V2 Installed Component Status Change",
};

export interface GreengrassEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "GreengrassEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: per-device deployment status
   * changes (a deployment succeeding/failing on a core device) and/or
   * installed component status changes (a component entering `BROKEN`).
   * @default ["deployment-status"]
   */
  kinds?: readonly GreengrassEventKind[];
}

/**
 * Event source connecting IoT Greengrass V2 notifications to the hosting
 * compute. Greengrass publishes per-core-device deployment execution status
 * (`SUCCEEDED`, `FAILED`, …) and installed-component lifecycle changes (most
 * importantly a component dropping into `BROKEN`) to the account's default
 * EventBridge bus (source `aws.greengrass`); this subscribes the host
 * Function to those events so it can alert on failed rollouts or broken
 * edge software.
 *
 * Greengrass publishes to EventBridge automatically — no additional resource
 * is created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Greengrass Events
 * @example Alert When A Rollout Fails On A Device
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.GreengrassV2.consumeGreengrassEvents(
 *       { kinds: ["deployment-status"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail.coreDeviceExecutionStatus === "FAILED"
 *             ? Effect.logError(
 *                 `deployment ${event.detail.deploymentId} failed on ${event.detail.coreDeviceThingName}`,
 *               )
 *             : Effect.void,
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeGreengrassEvents = <StreamReq = never, Req = never>(
  props: GreengrassEventSourceProps,
  process: (
    events: Stream.Stream<GreengrassEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "GreengrassEvents",
    {
      source: ["aws.greengrass"],
      "detail-type": (props.kinds ?? (["deployment-status"] as const)).map(
        (kind) => DETAIL_TYPES[kind],
      ),
    },
    { description: props.description, state: props.state },
    process,
  );
