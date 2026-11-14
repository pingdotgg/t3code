import * as appsignals from "@distilled.cloud/aws/application-signals";
import * as Layer from "effect/Layer";
import { makeApplicationSignalsAccountHttpBinding } from "./BindingHttp.ts";
import { ListServiceDependencies } from "./ListServiceDependencies.ts";

export const ListServiceDependenciesHttp = Layer.effect(
  ListServiceDependencies,
  makeApplicationSignalsAccountHttpBinding({
    tag: "AWS.ApplicationSignals.ListServiceDependencies",
    operation: appsignals.listServiceDependencies,
    actions: ["application-signals:ListServiceDependencies"],
  }),
);
