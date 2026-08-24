import type * as amplify from "@distilled.cloud/aws/amplify";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Amplify Hosting delivers to EventBridge when a
 * deployment (build job) changes status.
 */
export interface DeploymentStatusChangeDetail {
  /**
   * ID of the Amplify app the job belongs to.
   */
  appId: string;
  /**
   * Name of the branch the job ran on.
   */
  branchName: string;
  /**
   * ID of the build job whose status changed.
   */
  jobId: string;
  /**
   * New status of the job (`STARTED`, `SUCCEED`, or `FAILED`).
   */
  jobStatus: amplify.JobStatus;
}

/** A deployment-status-change EventBridge event delivered to the handler. */
export type DeploymentStatusChangeEvent =
  EventRecord<DeploymentStatusChangeDetail>;

export interface DeploymentStatusChangeEventSourceProps extends EventRouteProps {
  /**
   * Logical id prefix for the backing EventBridge rule.
   * @default "Amplify"
   */
  id?: string;
  /**
   * Only deliver events whose `jobStatus` is one of these values. Omit to
   * receive every status transition (`STARTED`, `SUCCEED`, `FAILED`).
   */
  jobStatus?: amplify.JobStatus[];
}

/**
 * Deliver Amplify Hosting deployment status changes (`aws.amplify` /
 * `"Amplify Deployment Status Change"` EventBridge events) to the host
 * Function — e.g. to notify a chat channel on failed builds or kick off
 * cache invalidation when a deploy succeeds.
 *
 * The EventBridge pattern matches every Amplify app in the account and
 * region (the pattern must be literal — `Output` values such as `app.appId`
 * do not resolve inside the deployed bundle); inspect `event.detail.appId` /
 * `event.detail.branchName` in the handler if multiple apps share the
 * Function. Provide `AWS.Lambda.EventSource` on the Function effect to
 * implement the subscription.
 *
 * @section Reacting To Deployments
 * @example Alert on Failed Builds
 * ```typescript
 * yield* AWS.Amplify.consumeDeploymentStatusChanges(
 *   { jobStatus: ["FAILED"] },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(
 *         `build ${event.detail.jobId} failed on ` +
 *           `${event.detail.appId}/${event.detail.branchName}`,
 *       ),
 *     ),
 * );
 * ```
 *
 * @example Register the Event Source inside a Lambda Function
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export class DeployHooks extends AWS.Lambda.Function<AWS.Lambda.Function>()(
 *   "DeployHooks",
 * ) {}
 *
 * export default DeployHooks.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.Amplify.consumeDeploymentStatusChanges(
 *       { jobStatus: ["SUCCEED"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(`deployed ${event.detail.branchName}`),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeDeploymentStatusChanges = <StreamReq = never, Req = never>(
  props: DeploymentStatusChangeEventSourceProps,
  process: (
    events: Stream.Stream<DeploymentStatusChangeEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  Effect.gen(function* () {
    const { id, jobStatus, ...routeProps } = props;

    yield* consumeBusEvents(
      `${id ?? "Amplify"}-DeploymentStatusChanges`,
      {
        source: ["aws.amplify"],
        "detail-type": ["Amplify Deployment Status Change"],
        ...(jobStatus && jobStatus.length > 0 ? { detail: { jobStatus } } : {}),
      },
      routeProps,
      process,
    );
  });
