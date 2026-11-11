import * as frauddetector from "@distilled.cloud/aws/frauddetector";
import * as Layer from "effect/Layer";
import { makeFraudDetectorEventTypeHttpBinding } from "./BindingHttp.ts";
import { DeleteEvent } from "./DeleteEvent.ts";

export const DeleteEventHttp = Layer.effect(
  DeleteEvent,
  makeFraudDetectorEventTypeHttpBinding({
    tag: "AWS.FraudDetector.DeleteEvent",
    operation: frauddetector.deleteEvent,
    actions: ["frauddetector:DeleteEvent"],
  }),
);
