import * as frauddetector from "@distilled.cloud/aws/frauddetector";
import * as Layer from "effect/Layer";
import { makeFraudDetectorEventTypeHttpBinding } from "./BindingHttp.ts";
import { UpdateEventLabel } from "./UpdateEventLabel.ts";

export const UpdateEventLabelHttp = Layer.effect(
  UpdateEventLabel,
  makeFraudDetectorEventTypeHttpBinding({
    tag: "AWS.FraudDetector.UpdateEventLabel",
    operation: frauddetector.updateEventLabel,
    actions: ["frauddetector:UpdateEventLabel"],
  }),
);
