import * as frauddetector from "@distilled.cloud/aws/frauddetector";
import * as Layer from "effect/Layer";
import { makeFraudDetectorEventTypeHttpBinding } from "./BindingHttp.ts";
import { GetEvent } from "./GetEvent.ts";

export const GetEventHttp = Layer.effect(
  GetEvent,
  makeFraudDetectorEventTypeHttpBinding({
    tag: "AWS.FraudDetector.GetEvent",
    operation: frauddetector.getEvent,
    actions: ["frauddetector:GetEvent"],
  }),
);
