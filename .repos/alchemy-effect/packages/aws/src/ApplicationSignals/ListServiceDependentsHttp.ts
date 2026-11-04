import * as appsignals from "@distilled.cloud/aws/application-signals";
import * as Layer from "effect/Layer";
import { makeApplicationSignalsAccountHttpBinding } from "./BindingHttp.ts";
import { ListServiceDependents } from "./ListServiceDependents.ts";

export const ListServiceDependentsHttp = Layer.effect(
  ListServiceDependents,
  makeApplicationSignalsAccountHttpBinding({
    tag: "AWS.ApplicationSignals.ListServiceDependents",
    operation: appsignals.listServiceDependents,
    actions: ["application-signals:ListServiceDependents"],
  }),
);
