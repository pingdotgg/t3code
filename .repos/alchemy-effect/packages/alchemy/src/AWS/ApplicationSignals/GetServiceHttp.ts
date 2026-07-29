import * as appsignals from "@distilled.cloud/aws/application-signals";
import * as Layer from "effect/Layer";
import { makeApplicationSignalsAccountHttpBinding } from "./BindingHttp.ts";
import { GetService } from "./GetService.ts";

export const GetServiceHttp = Layer.effect(
  GetService,
  makeApplicationSignalsAccountHttpBinding({
    tag: "AWS.ApplicationSignals.GetService",
    operation: appsignals.getService,
    actions: ["application-signals:GetService"],
  }),
);
