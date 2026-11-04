import * as frauddetector from "@distilled.cloud/aws/frauddetector";
import * as Layer from "effect/Layer";
import { makeFraudDetectorDetectorHttpBinding } from "./BindingHttp.ts";
import { GetEventPrediction } from "./GetEventPrediction.ts";

export const GetEventPredictionHttp = Layer.effect(
  GetEventPrediction,
  makeFraudDetectorDetectorHttpBinding({
    tag: "AWS.FraudDetector.GetEventPrediction",
    operation: frauddetector.getEventPrediction,
    actions: ["frauddetector:GetEventPrediction"],
  }),
);
