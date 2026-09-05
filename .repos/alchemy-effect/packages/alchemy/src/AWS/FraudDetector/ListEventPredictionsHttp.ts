import * as frauddetector from "@distilled.cloud/aws/frauddetector";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Detector } from "./Detector.ts";
import { ListEventPredictions } from "./ListEventPredictions.ts";

/**
 * Bespoke implementation — unlike the other detector-scoped operations, the
 * detector is a `FilterCondition` (`{ value }`) rather than a plain
 * `detectorId` field, and `frauddetector:ListEventPredictions` supports no
 * resource-level IAM scoping, so the grant is on `*`.
 */
export const ListEventPredictionsHttp = Layer.effect(
  ListEventPredictions,
  Effect.gen(function* () {
    const op = yield* frauddetector.listEventPredictions;

    return Effect.fn(function* (detector: Detector) {
      // Output yields a DEFERRED effect — resolve again per invocation below.
      const DetectorId = yield* detector.detectorId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.FraudDetector.ListEventPredictions(${detector}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["frauddetector:ListEventPredictions"],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.FraudDetector.ListEventPredictions(${detector.LogicalId})`,
      )(function* (
        request: Omit<frauddetector.ListEventPredictionsRequest, "detectorId">,
      ) {
        const detectorId = yield* DetectorId;
        return yield* op({ ...request, detectorId: { value: detectorId } });
      });
    });
  }),
);
