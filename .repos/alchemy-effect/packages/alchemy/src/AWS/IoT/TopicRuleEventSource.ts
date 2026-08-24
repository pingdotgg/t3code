import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * The JSON message delivered to the handler. This is exactly the payload
 * produced by the rule's SQL `SELECT` — for a `SELECT *` rule it is the raw
 * MQTT message body, and for enriched SQL it also carries the selected
 * metadata (`topic()`, `timestamp()`, ...).
 */
export type IoTMessage = Record<string, unknown>;

export interface TopicRuleEventSourceProps {
  /**
   * Explicit rule name. Rule names may only contain `[a-zA-Z0-9_]`.
   * If omitted, a unique name is generated.
   */
  ruleName?: string;

  /**
   * Override the rule's SQL statement. When omitted, the rule uses
   * `SELECT * FROM '${topicFilter}'`.
   */
  sql?: string;

  /**
   * The SQL rules engine version.
   * @default "2016-03-23"
   */
  awsIotSqlVersion?: string;
}

type MessagesHandler<Req> = (
  stream: Stream.Stream<IoTMessage>,
) => Effect.Effect<void, never, Req>;

/**
 * Invoke an Effect handler for every MQTT message matching an IoT topic
 * filter, by creating an IoT {@link TopicRule} with a Lambda action targeting
 * the current function.
 *
 * Provide the host-specific implementation layer on the Function —
 * `AWS.Lambda.TopicRuleEventSource` creates the topic rule and dispatches
 * matching invocations to the handler.
 *
 * @param topicFilter The MQTT topic (filter) to subscribe to, e.g.
 *   `sensors/+/telemetry`.
 * @param props Optional rule configuration.
 * @param process The handler invoked with a stream of matching messages.
 *
 * @example Consume MQTT messages in a Lambda
 * ```typescript
 * export default IngestFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const table = yield* Table;
 *     const putItem = yield* AWS.DynamoDB.PutItem(table);
 *
 *     yield* AWS.IoT.consumeTopicMessages("sensors/+/telemetry", (messages) =>
 *       messages.pipe(
 *         Stream.runForEach((message) =>
 *           putItem({
 *             Item: { pk: { S: String(message.deviceId) } },
 *           }),
 *         ),
 *         Effect.orDie,
 *       ),
 *     );
 *
 *     return {};
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(AWS.Lambda.TopicRuleEventSource, AWS.DynamoDB.PutItemHttp),
 *     ),
 *   ),
 * );
 * ```
 *
 * @example Enrich the payload with rule SQL
 * ```typescript
 * yield* AWS.IoT.consumeTopicMessages(
 *   "sensors/+/telemetry",
 *   { sql: "SELECT *, topic(2) AS deviceId FROM 'sensors/+/telemetry'" },
 *   (messages) =>
 *     messages.pipe(
 *       Stream.runForEach((message) => Effect.log(message.deviceId)),
 *       Effect.orDie,
 *     ),
 * );
 * ```
 */
export function consumeTopicMessages<Req = never>(
  topicFilter: string,
  process: MessagesHandler<Req>,
): Effect.Effect<void, never, TopicRuleEventSource>;
export function consumeTopicMessages<Req = never>(
  topicFilter: string,
  props: TopicRuleEventSourceProps,
  process: MessagesHandler<Req>,
): Effect.Effect<void, never, TopicRuleEventSource>;
export function consumeTopicMessages<Req = never>(
  topicFilter: string,
  propsOrProcess: TopicRuleEventSourceProps | MessagesHandler<Req>,
  maybeProcess?: MessagesHandler<Req>,
): Effect.Effect<void, never, TopicRuleEventSource> {
  const [props, process] =
    typeof propsOrProcess === "function"
      ? [{} as TopicRuleEventSourceProps, propsOrProcess]
      : [propsOrProcess, maybeProcess!];
  return TopicRuleEventSource.use((source) =>
    source(topicFilter, props, process),
  );
}

/**
 * Event source connecting an IoT topic filter to the hosting compute.
 *
 * The contract is a Context service consumed via
 * {@link consumeTopicMessages}; the Lambda implementation layer is
 * `AWS.Lambda.TopicRuleEventSource`, which deploys an IoT {@link TopicRule}
 * with a Lambda action (plus the invoke permission) and streams matching
 * messages into the registered handler.
 * @binding
 */
export class TopicRuleEventSource extends Context.Service<
  TopicRuleEventSource,
  TopicRuleEventSourceService
>()("AWS.IoT.TopicRuleEventSource") {}

export type TopicRuleEventSourceService = <Req = never>(
  topicFilter: string,
  props: TopicRuleEventSourceProps,
  process: (
    stream: Stream.Stream<IoTMessage>,
  ) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;
