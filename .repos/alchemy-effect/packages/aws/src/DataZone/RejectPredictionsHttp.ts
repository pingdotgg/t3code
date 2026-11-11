import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { RejectPredictions } from "./RejectPredictions.ts";

export const RejectPredictionsHttp = Layer.effect(
  RejectPredictions,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.RejectPredictions",
    operation: datazone.rejectPredictions,
    actions: ["datazone:RejectPredictions"],
  }),
);
