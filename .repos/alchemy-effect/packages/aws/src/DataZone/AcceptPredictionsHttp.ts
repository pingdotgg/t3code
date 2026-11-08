import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { AcceptPredictions } from "./AcceptPredictions.ts";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";

export const AcceptPredictionsHttp = Layer.effect(
  AcceptPredictions,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.AcceptPredictions",
    operation: datazone.acceptPredictions,
    actions: ["datazone:AcceptPredictions"],
  }),
);
