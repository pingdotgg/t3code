import type * as frauddetector from "@distilled.cloud/aws/frauddetector";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EventType } from "./EventType.ts";

/**
 * The `eventTypeName` is injected by the binding from the bound event type;
 * everything else (the event id, timestamp, entities, variable values, and
 * optional label) is the raw distilled request.
 */
export interface SendEventRequest extends Omit<
  frauddetector.SendEventRequest,
  "eventTypeName"
> {}

/**
 * Store an event in Amazon Fraud Detector without generating a prediction —
 * the effectful ingestion call made from a deployed Lambda or Task. Stored
 * events build the historical dataset used to train models and can be
 * labeled later via `UpdateEventLabel`. The bound event type must have
 * `eventIngestion: "ENABLED"`.
 *
 * @binding
 * @section Ingesting Events
 * Provide the `SendEventHttp` implementation layer on the Function effect,
 * bind the event type in the init phase, then call the returned client at
 * runtime. The binding grants `frauddetector:SendEvent` on the event type
 * and injects its `eventTypeName` automatically.
 *
 * @example Ingest from a Lambda
 * ```typescript
 * // init
 * const sendEvent = yield* FraudDetector.SendEvent(eventType);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* sendEvent({
 *       eventId: "order-123",
 *       eventTimestamp: new Date().toISOString(),
 *       entities: [{ entityType: "customer", entityId: "cust-1" }],
 *       eventVariables: { email: "buyer@example.com", ip: "1.2.3.4" },
 *     });
 *     return HttpServerResponse.json({ ok: true });
 *   }),
 * };
 * // on the Function effect:
 * // .pipe(Effect.provide(FraudDetector.SendEventHttp))
 * ```
 */
export interface SendEvent extends Binding.Service<
  SendEvent,
  "AWS.FraudDetector.SendEvent",
  (
    eventType: EventType,
  ) => Effect.Effect<
    (
      request: SendEventRequest,
    ) => Effect.Effect<
      frauddetector.SendEventResult,
      frauddetector.SendEventError
    >
  >
> {}
export const SendEvent = Binding.Service<SendEvent>(
  "AWS.FraudDetector.SendEvent",
);
