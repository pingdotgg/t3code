import * as frauddetector from "@distilled.cloud/aws/frauddetector";
import * as Layer from "effect/Layer";
import { makeFraudDetectorEventTypeHttpBinding } from "./BindingHttp.ts";
import { DeleteEventsByEventType } from "./DeleteEventsByEventType.ts";

export const DeleteEventsByEventTypeHttp = Layer.effect(
  DeleteEventsByEventType,
  makeFraudDetectorEventTypeHttpBinding({
    tag: "AWS.FraudDetector.DeleteEventsByEventType",
    operation: frauddetector.deleteEventsByEventType,
    actions: ["frauddetector:DeleteEventsByEventType"],
  }),
);
