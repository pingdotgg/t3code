import type * as lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
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
 * Lambda runtime implementation for `AWS.EventBridge.consumeBusEvents(...)`.
 *
 * This layer does two things:
 *
 * 1. It delegates to `EventSourcePolicy` so deployment creates an EventBridge
 *    rule targeting the current Lambda function.
 * 2. At runtime it filters incoming Lambda events against the original event
 *    pattern and forwards matching events into the supplied `Stream`.
 * @binding
 * @section Subscribing To The Default Bus
 * @example Match User Events On The Default Bus
 * ```typescript
 * yield* AWS.EventBridge.consumeBusEvents(
 *   {
 *     source: ["app.user"],
 *     "detail-type": ["UserCreated"],
 *   },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(`new user: ${event.detail.userId}`),
 *     ),
 * );
 * ```
 *
 * @section Subscribing To A Custom Bus
 * @example Match Orders On A Named Bus
 * ```typescript
 * const bus = yield* AWS.EventBridge.EventBus("OrdersBus", {
 *   name: "orders",
 * });
 *
 * yield* AWS.EventBridge.consumeBusEvents(
 *   bus,
 *   {
 *     source: ["app.orders"],
 *     "detail-type": ["OrderPaid"],
 *   },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(`paid order: ${event.detail.orderId}`),
 *     ),
 * );
 * ```
 *
 * @section Explicit Route Names
 * @example Name The Backing Rule Deterministically
 * ```typescript
 * yield* AWS.EventBridge.consumeBusEvents(
 *   "InvoiceEvents",
 *   {
 *     source: ["app.billing"],
 *     "detail-type": ["InvoiceIssued"],
 *   },
 *   {
 *     description: "Deliver invoice events into this Lambda function",
 *   },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(`invoice: ${event.detail.invoiceId}`),
 *     ),
 * );
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
 * yield* AWS.EventBridge.consumeBusEvents(
 *   {
 *     source: ["app.user"],
 *     "detail-type": ["UserCreated"],
 *   },
 *   (events) =>
 *     Stream.runForEach(
 *       events as Stream.Stream<AWS.EventBridge.EventRecord<UserCreated>>,
 *       (event) => Effect.log(`welcome ${event.detail.email}`),
 *     ),
 * );
 * ```
 */
export const EventSource = Layer.effect(
  EventBridgeEventSource,
  Effect.gen(function* () {
    const host = yield* Lambda.Function;

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
      // Deploy-time: create the backing EventBridge rule + Lambda permission
      // targeting this function. Skipped once running inside the deployed
      // Function (the global guard), where the only work is registering the
      // runtime handler below.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* createLambdaRoute(descriptor, host).pipe(Effect.asVoid);
      }

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
