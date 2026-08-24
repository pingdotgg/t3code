import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { AcceptPredictions } from "./AcceptPredictions.ts";

export const AcceptPredictionsHttp = Layer.effect(
  AcceptPredictions,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.AcceptPredictions",
    operation: datazone.acceptPredictions,
    actions: ["datazone:AcceptPredictions"],
  }),
);
