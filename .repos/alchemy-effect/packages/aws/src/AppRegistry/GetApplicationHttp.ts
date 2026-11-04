import * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import * as Layer from "effect/Layer";
import { makeApplicationScopedHttpBinding } from "./BindingHttp.ts";
import { GetApplication } from "./GetApplication.ts";

export const GetApplicationHttp = Layer.effect(
  GetApplication,
  makeApplicationScopedHttpBinding({
    tag: "AWS.AppRegistry.GetApplication",
    operation: appregistry.getApplication,
    actions: ["servicecatalog:GetApplication"],
  }),
);
