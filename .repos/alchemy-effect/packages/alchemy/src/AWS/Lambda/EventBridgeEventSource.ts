import type * as lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import {
  EventSource as EventBridgeEventSource,
  matchesEventPattern,
  type EventPattern,
  type EventRecord,
  type EventRouteProps,
  type EventSourceService,
} from "../EventBridge/EventSource.ts";
import { toLambda as createLambdaRoute } from "../EventBridge/ToLambda.ts";
import * as Lambda from "./Function.ts";

/**
 * Narrow an arbitrary Lambda invocation payload to an EventBridge event.
 */
export const isEventBridgeEvent = (
  event: any,
): event is lambda.EventBridgeEvent<string, any> =>
  typeof event?.source === "string" &&
  typeof event?.["detail-type"] === "string";

/**
 * Lambda runtime implementation for `AWS.EventBridge.events(...).subscribe(...)`.
 *
 * This layer does two things:
 *
 * 1. It delegates to `EventSourcePolicy` so deployment creates an EventBridge
 *    rule targeting the current Lambda function.
 * 2. At runtime it filters incoming Lambda events against the original event
 *    pattern and forwards matching events into the supplied `Stream`.
 *
 * @section Subscribing To The Default Bus
 * @example Match User Events On The Default Bus
 * ```typescript
 * yield* AWS.EventBridge
 *   .events({
 *     source: ["app.user"],
 *     "detail-type": ["UserCreated"],
 *   })
 *   .subscribe((events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(`new user: ${event.detail.userId}`),
 *     ),
 *   );
 * ```
 *
 * @section Subscribing To A Custom Bus
 * @example Match Orders On A Named Bus
 * ```typescript
 * const bus = yield* AWS.EventBridge.EventBus("OrdersBus", {
 *   name: "orders",
 * });
 *
 * yield* AWS.EventBridge
 *   .events(bus, {
 *     source: ["app.orders"],
 *     "detail-type": ["OrderPaid"],
 *   })
 *   .subscribe((events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(`paid order: ${event.detail.orderId}`),
 *     ),
 *   );
 * ```
 *
 * @section Explicit Route Names
 * @example Name The Backing Rule Deterministically
 * ```typescript
 * yield* AWS.EventBridge
 *   .events(
 *     "InvoiceEvents",
 *     {
 *       source: ["app.billing"],
 *       "detail-type": ["InvoiceIssued"],
 *     },
 *     {
 *       description: "Deliver invoice events into this Lambda function",
 *     },
 *   )
 *   .subscribe((events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(`invoice: ${event.detail.invoiceId}`),
 *     ),
 *   );
 * ```
 *
 * @section Processing Typed Details
 * @example Narrow The Event Detail Payload
 * ```typescript
 * type UserCreated = {
 *   userId: string;
 *   email: string;
 * };
 *
 * yield* AWS.EventBridge
 *   .events({
 *     source: ["app.user"],
 *     "detail-type": ["UserCreated"],
 *   })
 *   .subscribe((events) =>
 *     Stream.runForEach(
 *       events as Stream.Stream<AWS.EventBridge.EventRecord<UserCreated>>,
 *       (event) => Effect.log(`welcome ${event.detail.email}`),
 *     ),
 *   );
 * ```
 */
export const EventSource = Layer.effect(
  EventBridgeEventSource,
  Effect.gen(function* () {
    const host = yield* Lambda.Function;
    const bind = yield* EventSourcePolicy;

    return Effect.fn(function* <
      Detail = unknown,
      StreamReq = never,
      Req = never,
    >(
      descriptor: {
        id?: string;
        bus?: any;
        pattern: EventPattern;
        props?: EventRouteProps;
      },
      process: (
        events: Stream.Stream<EventRecord<Detail>, never, StreamReq>,
      ) => Effect.Effect<void, never, Req>,
    ) {
      yield* bind(descriptor);

      yield* host.listen(
        Effect.sync(() => (event: any) => {
          if (
            isEventBridgeEvent(event) &&
            matchesEventPattern(descriptor.pattern, event)
          ) {
            return process(Stream.succeed(event as EventRecord<Detail>)).pipe(
              Effect.orDie,
            );
          }
        }),
      );
    }) as EventSourceService;
  }),
);

/**
 * Deploy-time policy/service bridge for EventBridge subscriptions.
 *
 * Runtime-specific implementations use this to materialize the infrastructure
 * wiring required by `events(...).subscribe(...)`.
 */
export class EventSourcePolicy extends Binding.Policy<
  EventSourcePolicy,
  (
    descriptor: Parameters<EventSourceService>[0],
  ) => Effect.Effect<void, never, any>
>()("AWS.EventBridge.EventSource") {}

/**
 * Lambda-specific EventBridge subscription wiring.
 *
 * Subscribing a Lambda function to an EventBridge pattern creates a backing
 * rule with `toLambda(host)` so the function can receive matching events
 * without manual rule/permission setup.
 */
export const EventSourcePolicyLive = EventSourcePolicy.layer.succeed(
  Effect.fn(function* (host, descriptor) {
    if (Lambda.isFunction(host)) {
      yield* createLambdaRoute(descriptor, host).pipe(Effect.asVoid);
    } else {
      return yield* Effect.die(
        new Error(
          `EventBridge EventSource does not support runtime '${host.Type}'`,
        ),
      );
    }
  }) as any,
);
