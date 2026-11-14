import * as appsignals from "@distilled.cloud/aws/application-signals";
import * as Layer from "effect/Layer";
import { makeApplicationSignalsAccountHttpBinding } from "./BindingHttp.ts";
import { ListServiceOperations } from "./ListServiceOperations.ts";

export const ListServiceOperationsHttp = Layer.effect(
  ListServiceOperations,
  makeApplicationSignalsAccountHttpBinding({
    tag: "AWS.ApplicationSignals.ListServiceOperations",
    operation: appsignals.listServiceOperations,
    actions: ["application-signals:ListServiceOperations"],
  }),
);
