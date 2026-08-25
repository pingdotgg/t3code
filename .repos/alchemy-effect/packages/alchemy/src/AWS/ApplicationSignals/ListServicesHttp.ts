import * as appsignals from "@distilled.cloud/aws/application-signals";
import * as Layer from "effect/Layer";
import { makeApplicationSignalsAccountHttpBinding } from "./BindingHttp.ts";
import { ListServices } from "./ListServices.ts";

export const ListServicesHttp = Layer.effect(
  ListServices,
  makeApplicationSignalsAccountHttpBinding({
    tag: "AWS.ApplicationSignals.ListServices",
    operation: appsignals.listServices,
    actions: ["application-signals:ListServices"],
  }),
);
