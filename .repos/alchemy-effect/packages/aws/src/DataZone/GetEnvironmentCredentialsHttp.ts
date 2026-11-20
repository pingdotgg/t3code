import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneEnvironmentHttpBinding } from "./BindingHttp.ts";
import { GetEnvironmentCredentials } from "./GetEnvironmentCredentials.ts";

export const GetEnvironmentCredentialsHttp = Layer.effect(
  GetEnvironmentCredentials,
  makeDataZoneEnvironmentHttpBinding({
    tag: "AWS.DataZone.GetEnvironmentCredentials",
    operation: datazone.getEnvironmentCredentials,
    actions: ["datazone:GetEnvironmentCredentials"],
  }),
);
