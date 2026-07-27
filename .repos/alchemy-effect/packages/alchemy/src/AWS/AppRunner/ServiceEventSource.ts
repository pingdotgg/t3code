import type * as apprunner from "@distilled.cloud/aws/apprunner";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload App Runner delivers to EventBridge when a service's
 * lifecycle status changes (e.g. `OPERATION_IN_PROGRESS` -> `RUNNING`).
 */
export interface ServiceStatusChangeDetail {
  /** ID of the App Runner service whose status changed. */
  serviceId: string;
  /** Name of the App Runner service. */
  serviceName: string;
  /** The status the service transitioned into (e.g. `RUNNING`, `PAUSED`). */
  currentStatus: apprunner.ServiceStatus;
  /** The status the service transitioned out of. */
  previousStatus?: apprunner.ServiceStatus;
}

/**
 * The `detail` payload App Runner delivers to EventBridge when an
 * asynchronous operation (deployment, pause, resume, create, delete,
 * update) changes status.
 */
export interface OperationStatusChangeDetail {
  /** ID of the App Runner service the operation ran on. */
  serviceId: string;
  /** Name of the App Runner service. */
  serviceName: string;
  /** ID of the operation (matches `OperationId` from the initiating call). */
  operationId?: string;
  /**
   * New status of the operation, e.g. `DeploymentCompletedSuccessfully`,
   * `PauseServiceCompletedSuccessfully`, `DeploymentFailed`.
   */
  operationStatus: string;
}

/** A service-status-change EventBridge event delivered to the handler. */
export type ServiceStatusChangeEvent = EventRecord<ServiceStatusChangeDetail>;

/** An operation-status-change EventBridge event delivered to the handler. */
export type OperationStatusChangeEvent =
  EventRecord<OperationStatusChangeDetail>;

export interface ServiceStatusChangeEventSourceProps extends EventRouteProps {
  /**
   * Logical id prefix for the backing EventBridge rule.
   * @default "AppRunner"
   */
  id?: string;
  /**
   * Only deliver events whose `currentStatus` is one of these values. Omit
   * to receive every status transition.
   */
  currentStatus?: apprunner.ServiceStatus[];
}

export interface OperationStatusChangeEventSourceProps extends EventRouteProps {
  /**
   * Logical id prefix for the backing EventBridge rule.
   * @default "AppRunner"
   */
  id?: string;
  /**
   * Only deliver events whose `operationStatus` is one of these values
   * (e.g. `["DeploymentCompletedSuccessfully", "DeploymentFailed"]`). Omit
   * to receive every operation transition.
   */
  operationStatus?: string[];
}

/**
 * Deliver App Runner service status changes (`aws.apprunner` /
 * `"AppRunner Service Status Change"` EventBridge events) to the host
 * Function — e.g. to alert when a service unexpectedly leaves `RUNNING`.
 *
 * The EventBridge pattern matches every App Runner service in the account
 * and region (the pattern must be literal — `Output` values such as
 * `service.serviceId` do not resolve inside the deployed bundle); inspect
 * `event.detail.serviceName` / `event.detail.serviceId` in the handler if
 * multiple services share the Function. Provide `AWS.Lambda.EventSource` on
 * the Function effect to implement the subscription.
 *
 * @section Reacting To Status Changes
 * @example Alert when a Service Pauses
 * ```typescript
 * yield* AWS.AppRunner.consumeServiceStatusChanges(
 *   { currentStatus: ["PAUSED"] },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(`${event.detail.serviceName} is paused`),
 *     ),
 * );
 * ```
 */
export const consumeServiceStatusChanges = <StreamReq = never, Req = never>(
  props: ServiceStatusChangeEventSourceProps,
  process: (
    events: Stream.Stream<ServiceStatusChangeEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  Effect.gen(function* () {
    const { id, currentStatus, ...routeProps } = props;

    yield* consumeBusEvents(
      `${id ?? "AppRunner"}-ServiceStatusChanges`,
      {
        source: ["aws.apprunner"],
        "detail-type": ["AppRunner Service Status Change"],
        ...(currentStatus && currentStatus.length > 0
          ? { detail: { currentStatus } }
          : {}),
      },
      routeProps,
      process,
    );
  });

/**
 * Deliver App Runner operation status changes (`aws.apprunner` /
 * `"AppRunner Service Operation Status Change"` EventBridge events) to the
 * host Function — e.g. to notify a chat channel when a deployment completes
 * or fails.
 *
 * The EventBridge pattern matches every App Runner service in the account
 * and region; inspect `event.detail.serviceName` / `event.detail.operationId`
 * in the handler if multiple services share the Function. Provide
 * `AWS.Lambda.EventSource` on the Function effect to implement the
 * subscription.
 *
 * @section Reacting To Deployments
 * @example Alert on Failed Deployments
 * ```typescript
 * yield* AWS.AppRunner.consumeOperationStatusChanges(
 *   { operationStatus: ["DeploymentFailed"] },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(`deployment failed on ${event.detail.serviceName}`),
 *     ),
 * );
 * ```
 */
export const consumeOperationStatusChanges = <StreamReq = never, Req = never>(
  props: OperationStatusChangeEventSourceProps,
  process: (
    events: Stream.Stream<OperationStatusChangeEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  Effect.gen(function* () {
    const { id, operationStatus, ...routeProps } = props;

    yield* consumeBusEvents(
      `${id ?? "AppRunner"}-OperationStatusChanges`,
      {
        source: ["aws.apprunner"],
        "detail-type": ["AppRunner Service Operation Status Change"],
        ...(operationStatus && operationStatus.length > 0
          ? { detail: { operationStatus } }
          : {}),
      },
      routeProps,
      process,
    );
  });
