import * as appsignals from "@distilled.cloud/aws/application-signals";
import * as Layer from "effect/Layer";
import { makeApplicationSignalsAccountHttpBinding } from "./BindingHttp.ts";
import { ListServiceStates } from "./ListServiceStates.ts";

export const ListServiceStatesHttp = Layer.effect(
  ListServiceStates,
  makeApplicationSignalsAccountHttpBinding({
    tag: "AWS.ApplicationSignals.ListServiceStates",
    operation: appsignals.listServiceStates,
    actions: ["application-signals:ListServiceStates"],
  }),
);
