import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload CodeDeploy delivers to EventBridge when a deployment
 * or one of its instances changes state. Fields not shared by every event
 * kind are optional (the schema grows over time).
 */
export interface DeploymentEventDetail {
  /** The deployment's id (`d-…`). */
  deploymentId?: string;
  /** Name of the CodeDeploy application. */
  application?: string;
  /** Name of the deployment group. */
  deploymentGroup?: string;
  /**
   * The new state — `START`, `READY`, `SUCCESS`, `FAILURE`, or `STOP`.
   */
  state?: string;
  /** Region the deployment runs in. */
  region?: string;
  /** Instance state-change events: the affected instance's id. */
  instanceId?: string;
  /** Instance state-change events: the deployment's instance group id. */
  instanceGroupId?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A CodeDeploy EventBridge event delivered to the handler. */
export type DeploymentEvent = EventRecord<DeploymentEventDetail>;

/** Which CodeDeploy notifications to subscribe to. */
export type DeploymentEventKind = "deployment" | "instance";

const DETAIL_TYPES: Record<DeploymentEventKind, string> = {
  deployment: "CodeDeploy Deployment State-change Notification",
  instance: "CodeDeploy Instance State-change Notification",
};

export interface DeploymentEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "CodeDeployEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: deployment state changes,
   * per-instance state changes, or both.
   * @default ["deployment"]
   */
  kinds?: readonly DeploymentEventKind[];
  /**
   * Restrict to events about specific applications (matched against the
   * event's `application`).
   */
  applications?: readonly string[];
  /**
   * Restrict to events about specific deployment groups (matched against
   * the event's `deploymentGroup`).
   */
  deploymentGroups?: readonly string[];
}

/**
 * Event source connecting CodeDeploy deployment notifications to the
 * hosting compute. CodeDeploy publishes every deployment state change (and
 * per-instance state change) to the account's default EventBridge bus
 * (source `aws.codedeploy`); this subscribes the host Function to those
 * events so it can alert on failed deployments or chain post-deploy
 * automation.
 *
 * CodeDeploy publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Deployment Events
 * @example Alert On Failed Deployments
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.CodeDeploy.consumeDeploymentEvents(
 *       { kinds: ["deployment"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail.state === "FAILURE"
 *             ? Effect.log(`deployment ${event.detail.deploymentId} failed`)
 *             : Effect.void,
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeDeploymentEvents = <StreamReq = never, Req = never>(
  props: DeploymentEventSourceProps,
  process: (
    events: Stream.Stream<DeploymentEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "CodeDeployEvents",
    {
      source: ["aws.codedeploy"],
      "detail-type": (props.kinds ?? (["deployment"] as const)).map(
        (kind) => DETAIL_TYPES[kind],
      ),
      ...(props.applications !== undefined ||
      props.deploymentGroups !== undefined
        ? {
            detail: {
              ...(props.applications !== undefined
                ? { application: [...props.applications] }
                : {}),
              ...(props.deploymentGroups !== undefined
                ? { deploymentGroup: [...props.deploymentGroups] }
                : {}),
            },
          }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
