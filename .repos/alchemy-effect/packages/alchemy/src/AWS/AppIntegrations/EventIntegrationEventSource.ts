import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { EventBus } from "../EventBridge/EventBus.ts";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";
import { EventIntegration } from "./EventIntegration.ts";

/** A partner event delivered to the handler through an event integration. */
export type IntegrationEvent<Detail = unknown> = EventRecord<Detail>;

export interface IntegrationEventsProps {
  /**
   * Physical name for the event integration. If omitted, a deterministic
   * name is generated from the app, stage, and logical ID.
   */
  name?: string;
  /**
   * Description of the event integration (1-1000 characters).
   */
  description?: string;
  /**
   * The partner event source that pushes events to the EventBridge bus,
   * e.g. `aws.partner/examplepartner.com`. Also used as the literal
   * EventBridge rule pattern (`source`), so it must be a plain string —
   * Output values cannot appear in event patterns because the pattern is
   * also matched inside the deployed bundle at runtime.
   */
  source: string;
  /**
   * The EventBridge bus the partner events are delivered to. Omit to use
   * the account's default event bus.
   */
  bus?: EventBus;
  /**
   * Additional `detail-type` values to narrow the EventBridge rule pattern.
   * By default every event from `source` is delivered.
   */
  detailType?: string[];
  /**
   * Options forwarded to the backing EventBridge rule (description, state).
   */
  rule?: EventRouteProps;
  /**
   * Tags to apply to the event integration. Merged with internal Alchemy
   * tags.
   */
  tags?: Record<string, string>;
}

/**
 * Consume partner events on the host Function through an AppIntegrations
 * {@link EventIntegration}. Creates the event integration (the metadata that
 * connects the partner source to the EventBridge bus) and subscribes the
 * host Function to the matching events via an EventBridge rule.
 *
 * Returns the created {@link EventIntegration} so it can be passed to other
 * bindings (e.g. `ListEventIntegrationAssociations`).
 *
 * @section Consuming Integration Events
 * @example Consume Partner Events on a Lambda Function
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 * import { consumeIntegrationEvents } from "alchemy/AWS/AppIntegrations";
 *
 * // init — creates the EventIntegration + EventBridge rule and registers
 * // the runtime handler (provide AWS.Lambda.EventSource on the Function)
 * const integration = yield* consumeIntegrationEvents(
 *   "PartnerEvents",
 *   { source: "aws.partner/examplepartner.com" },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(event["detail-type"], event.detail),
 *     ),
 * );
 * ```
 *
 * @example Narrow by Detail Type on a Custom Bus
 * ```typescript
 * const bus = yield* AWS.EventBridge.EventBus("PartnerBus");
 * yield* consumeIntegrationEvents(
 *   "PartnerEvents",
 *   {
 *     source: "aws.partner/examplepartner.com",
 *     bus,
 *     detailType: ["OrderCreated"],
 *   },
 *   (events) => Stream.runForEach(events, handleOrder),
 * );
 * ```
 */
export const consumeIntegrationEvents = <
  Detail = unknown,
  StreamReq = never,
  Req = never,
>(
  id: string,
  props: IntegrationEventsProps,
  process: (
    events: Stream.Stream<IntegrationEvent<Detail>, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  Effect.gen(function* () {
    // Persist the integration metadata connecting the partner source to the
    // EventBridge bus.
    const integration = yield* EventIntegration(id, {
      name: props.name,
      description: props.description,
      source: props.source,
      eventBridgeBus: props.bus ? props.bus.eventBusName : "default",
      tags: props.tags,
    });

    // Subscribe the host Function to the matching partner events. The
    // pattern uses only literal values so it round-trips through both the
    // deploy-time rule and the runtime matcher.
    const pattern = {
      source: [props.source],
      ...(props.detailType ? { "detail-type": props.detailType } : {}),
    };
    yield* props.bus
      ? consumeBusEvents(
          `${id}-Events`,
          props.bus,
          pattern,
          props.rule,
          process,
        )
      : consumeBusEvents(`${id}-Events`, pattern, props.rule, process);

    return integration;
  });
