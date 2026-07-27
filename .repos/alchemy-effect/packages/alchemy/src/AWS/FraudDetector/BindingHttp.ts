import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Detector } from "./Detector.ts";
import type { EventType } from "./EventType.ts";
import type { List } from "./List.ts";

/**
 * Shared scaffolding for Amazon Fraud Detector HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two builders
 * below. Everything except the operation and the IAM action list is
 * boilerplate.
 */

/**
 * Build the impl Effect for a Fraud Detector operation scoped to a
 * {@link Detector}: the deploy-time half grants `actions` on the bound
 * detector's ARN, and the runtime half injects the detector's `detectorId`
 * into every request.
 */
export const makeFraudDetectorDetectorHttpBinding = <
  I extends { detectorId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.FraudDetector.GetEventPrediction`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the detector ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (detector: Detector) {
      // Output yields a DEFERRED effect — resolve again per invocation below.
      const DetectorId = yield* detector.detectorId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${detector}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [detector.arn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${detector.LogicalId})`)(function* (
        request: Omit<I, "detectorId">,
      ) {
        const detectorId = yield* DetectorId;
        return yield* op({ ...request, detectorId } as I);
      });
    });
  });

/**
 * Build the impl Effect for a Fraud Detector event data-plane operation
 * scoped to an {@link EventType} (`SendEvent`, `GetEvent`, `DeleteEvent`,
 * `UpdateEventLabel`): the deploy-time half grants `actions` on the bound
 * event type's ARN, and the runtime half injects the event type's
 * `eventTypeName` into every request.
 */
/**
 * Build the impl Effect for a Fraud Detector list data-plane operation scoped
 * to a {@link List} (`GetListElements`, `UpdateList`): the deploy-time half
 * grants `actions` on the bound list's ARN, and the runtime half injects the
 * list's `name` into every request.
 */
export const makeFraudDetectorListHttpBinding = <
  I extends { name: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.FraudDetector.GetListElements`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the list ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (list: List) {
      // Output yields a DEFERRED effect — resolve again per invocation below.
      const ListName = yield* list.name;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${list}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [list.arn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${list.LogicalId})`)(function* (
        request: Omit<I, "name">,
      ) {
        const name = yield* ListName;
        return yield* op({ ...request, name } as unknown as I);
      });
    });
  });

export const makeFraudDetectorEventTypeHttpBinding = <
  I extends { eventTypeName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.FraudDetector.SendEvent`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the event type ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (eventType: EventType) {
      // Output yields a DEFERRED effect — resolve again per invocation below.
      const EventTypeName = yield* eventType.name;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${eventType}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [eventType.arn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${eventType.LogicalId})`)(function* (
        request: Omit<I, "eventTypeName">,
      ) {
        const eventTypeName = yield* EventTypeName;
        return yield* op({ ...request, eventTypeName } as unknown as I);
      });
    });
  });
