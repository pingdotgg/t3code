import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Systems Manager delivers to EventBridge when a
 * Parameter Store parameter changes (`Parameter Store Change`) or a
 * parameter policy fires (`Parameter Store Policy Action`). Fields not
 * shared by every event kind are optional (the schema grows over time).
 */
export interface ParameterEventDetail {
  /** The parameter name, e.g. `/my-app/prod/db-url`. */
  name?: string;
  /** The parameter type (`String`, `StringList`, `SecureString`). */
  type?: string;
  /** What happened: `Create`, `Update`, `Delete`, or `LabelParameterVersion`. */
  operation?: string;
  /** The parameter description, when present. */
  description?: string;
  /** Policy events: the policy type that fired (`Expiration`, `ExpirationNotification`, `NoChangeNotification`). */
  "policy-type"?: string;
  /** Policy events: the policy content that fired. */
  "policy-content"?: string;
  /** Policy events: the action taken by the policy. */
  "action-reason"?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An SSM Parameter Store EventBridge event delivered to the handler. */
export type ParameterEvent = EventRecord<ParameterEventDetail>;

/** Which SSM Parameter Store events to subscribe to. */
export type ParameterEventKind = "change" | "policy-action";

const DETAIL_TYPES: Record<ParameterEventKind, string> = {
  change: "Parameter Store Change",
  "policy-action": "Parameter Store Policy Action",
};

export interface ParameterEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "SSMParameterEvents"
   */
  id?: string;
  /**
   * Which Parameter Store events to subscribe to.
   * @default all kinds
   */
  kinds?: readonly ParameterEventKind[];
  /**
   * Restrict the subscription to specific parameter names. Omit to receive
   * events for every parameter in the account/region.
   */
  names?: readonly string[];
}

/**
 * Event source connecting SSM Parameter Store changes to the hosting compute.
 * Systems Manager publishes every parameter create/update/delete (and
 * parameter-policy action, e.g. expiration) to the account's default
 * EventBridge bus (source `aws.ssm`); this subscribes the host Function to
 * those events so it can react to configuration changes — refresh caches,
 * fan out notifications, or audit secret rotation.
 *
 * Parameter Store publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Parameter Events
 * @example React To Parameter Changes
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default ConfigWatcher.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.SSM.consumeParameterEvents(
 *       { kinds: ["change"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(
 *             `${event.detail.operation}: ${event.detail.name}`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeParameterEvents = <StreamReq = never, Req = never>(
  props: ParameterEventSourceProps,
  process: (
    events: Stream.Stream<ParameterEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "SSMParameterEvents",
    {
      source: ["aws.ssm"],
      "detail-type": (
        props.kinds ?? (Object.keys(DETAIL_TYPES) as ParameterEventKind[])
      ).map((kind) => DETAIL_TYPES[kind]),
      ...(props.names !== undefined && props.names.length > 0
        ? { detail: { name: [...props.names] } }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
