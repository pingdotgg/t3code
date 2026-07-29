import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload AWS Config delivers to EventBridge. Compliance-change
 * events carry `configRuleName` and the new/old evaluation results;
 * configuration-item-change events carry `configurationItem` /
 * `configurationItemDiff`. Fields not shared by every event kind are
 * optional (the schema grows over time).
 */
export interface ConfigEventDetail {
  /** Compliance events: the name of the rule that changed compliance. */
  configRuleName?: string;
  /** Compliance events: the ARN of the rule. */
  configRuleARN?: string;
  /** The type of resource the event is about, e.g. `AWS::S3::Bucket`. */
  resourceType?: string;
  /** The id of the resource the event is about. */
  resourceId?: string;
  /**
   * The Config notification type, e.g. `ComplianceChangeNotification` or
   * `ConfigurationItemChangeNotification`.
   */
  messageType?: string;
  /** Compliance events: the new evaluation result (`complianceType`, …). */
  newEvaluationResult?: Record<string, unknown>;
  /** Compliance events: the previous evaluation result. */
  oldEvaluationResult?: Record<string, unknown>;
  /** Configuration-item events: the recorded configuration item. */
  configurationItem?: Record<string, unknown>;
  /** Configuration-item events: the diff against the previous item. */
  configurationItemDiff?: Record<string, unknown>;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An AWS Config EventBridge event delivered to the handler. */
export type ConfigEvent = EventRecord<ConfigEventDetail>;

/** Which AWS Config notifications to subscribe to. */
export type ConfigEventKind =
  | "compliance"
  | "configuration-item"
  | "snapshot-delivery"
  | "history-delivery";

const DETAIL_TYPES: Record<ConfigEventKind, string> = {
  compliance: "Config Rules Compliance Change",
  "configuration-item": "Config Configuration Item Change",
  "snapshot-delivery": "Config Configuration Snapshot Delivery Status",
  "history-delivery": "Config Configuration History Delivery Status",
};

export interface ConfigEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "ConfigEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: rule compliance changes,
   * configuration item changes, or snapshot/history delivery status.
   * @default ["compliance"]
   */
  kinds?: readonly ConfigEventKind[];
  /**
   * Restrict to compliance events about specific Config rules (matched
   * against the event's `configRuleName`).
   */
  configRuleNames?: readonly string[];
  /**
   * Restrict to events about specific resource types (matched against the
   * event's `resourceType`).
   */
  resourceTypes?: readonly string[];
}

/**
 * Event source connecting AWS Config notifications to the hosting compute.
 * AWS Config publishes rule compliance changes and configuration item
 * changes to the account's default EventBridge bus (source `aws.config`);
 * this subscribes the host Function to those events so it can alert on
 * noncompliant resources or chain remediation automation.
 *
 * AWS Config publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Config Events
 * @example Alert On Noncompliant Resources
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.Config.consumeConfigEvents(
 *       { kinds: ["compliance"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(
 *             `${event.detail.configRuleName}: ${event.detail.resourceId} is now ` +
 *               `${(event.detail.newEvaluationResult as any)?.complianceType}`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeConfigEvents = <StreamReq = never, Req = never>(
  props: ConfigEventSourceProps,
  process: (
    events: Stream.Stream<ConfigEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) => {
  const detail = {
    ...(props.configRuleNames !== undefined
      ? { configRuleName: [...props.configRuleNames] }
      : {}),
    ...(props.resourceTypes !== undefined
      ? { resourceType: [...props.resourceTypes] }
      : {}),
  };
  return consumeBusEvents(
    props.id ?? "ConfigEvents",
    {
      source: ["aws.config"],
      "detail-type": (props.kinds ?? (["compliance"] as const)).map(
        (kind) => DETAIL_TYPES[kind],
      ),
      ...(Object.keys(detail).length > 0 ? { detail } : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
};
