import * as frauddetector from "@distilled.cloud/aws/frauddetector";
import * as Layer from "effect/Layer";
import { makeFraudDetectorEventTypeHttpBinding } from "./BindingHttp.ts";
import { GetDeleteEventsByEventTypeStatus } from "./GetDeleteEventsByEventTypeStatus.ts";

export const GetDeleteEventsByEventTypeStatusHttp = Layer.effect(
  GetDeleteEventsByEventTypeStatus,
  makeFraudDetectorEventTypeHttpBinding({
    tag: "AWS.FraudDetector.GetDeleteEventsByEventTypeStatus",
    operation: frauddetector.getDeleteEventsByEventTypeStatus,
    actions: ["frauddetector:GetDeleteEventsByEventTypeStatus"],
  }),
);
