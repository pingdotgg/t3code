import * as frauddetector from "@distilled.cloud/aws/frauddetector";
import * as Layer from "effect/Layer";
import { makeFraudDetectorDetectorHttpBinding } from "./BindingHttp.ts";
import { GetEventPredictionMetadata } from "./GetEventPredictionMetadata.ts";

export const GetEventPredictionMetadataHttp = Layer.effect(
  GetEventPredictionMetadata,
  makeFraudDetectorDetectorHttpBinding({
    tag: "AWS.FraudDetector.GetEventPredictionMetadata",
    operation: frauddetector.getEventPredictionMetadata,
    actions: ["frauddetector:GetEventPredictionMetadata"],
  }),
);
