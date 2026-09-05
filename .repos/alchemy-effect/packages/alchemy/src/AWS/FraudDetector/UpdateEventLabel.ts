import type * as frauddetector from "@distilled.cloud/aws/frauddetector";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EventType } from "./EventType.ts";

/**
 * The `eventTypeName` is injected by the binding from the bound event type;
 * the `eventId`, `assignedLabel`, and `labelTimestamp` remain. The label must
 * be one of the labels associated with the event type.
 */
export interface UpdateEventLabelRequest extends Omit<
  frauddetector.UpdateEventLabelRequest,
  "eventTypeName"
> {}

/**
 * Label a stored event in Amazon Fraud Detector — the effectful feedback
 * call made from a deployed Lambda or Task when ground truth arrives (e.g. a
 * chargeback confirms fraud). Labeled events improve future model training.
 *
 * @binding
 * @section Labeling Stored Events
 * Provide the `UpdateEventLabelHttp` implementation layer on the Function
 * effect, bind the event type in the init phase, then call the returned
 * client at runtime. The binding grants `frauddetector:UpdateEventLabel` on
 * the event type and injects its `eventTypeName` automatically.
 *
 * @example Label from a Lambda
 * ```typescript
 * // init
 * const updateEventLabel = yield* FraudDetector.UpdateEventLabel(eventType);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime — a chargeback arrived for this order
 *     yield* updateEventLabel({
 *       eventId: "order-123",
 *       assignedLabel: "fraud",
 *       labelTimestamp: new Date().toISOString(),
 *     });
 *     return HttpServerResponse.json({ ok: true });
 *   }),
 * };
 * // on the Function effect:
 * // .pipe(Effect.provide(FraudDetector.UpdateEventLabelHttp))
 * ```
 */
export interface UpdateEventLabel extends Binding.Service<
  UpdateEventLabel,
  "AWS.FraudDetector.UpdateEventLabel",
  (
    eventType: EventType,
  ) => Effect.Effect<
    (
      request: UpdateEventLabelRequest,
    ) => Effect.Effect<
      frauddetector.UpdateEventLabelResult,
      frauddetector.UpdateEventLabelError
    >
  >
> {}
export const UpdateEventLabel = Binding.Service<UpdateEventLabel>(
  "AWS.FraudDetector.UpdateEventLabel",
);
