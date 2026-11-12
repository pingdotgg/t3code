import * as frauddetector from "@distilled.cloud/aws/frauddetector";
import * as Layer from "effect/Layer";
import { makeFraudDetectorEventTypeHttpBinding } from "./BindingHttp.ts";
import { SendEvent } from "./SendEvent.ts";

export const SendEventHttp = Layer.effect(
  SendEvent,
  makeFraudDetectorEventTypeHttpBinding({
    tag: "AWS.FraudDetector.SendEvent",
    operation: frauddetector.sendEvent,
    actions: ["frauddetector:SendEvent"],
  }),
);
