import * as servicequotas from "@distilled.cloud/aws/service-quotas";
import * as Layer from "effect/Layer";
import { makeServiceQuotasHttpBinding } from "./BindingHttp.ts";
import { GetAutoManagementConfiguration } from "./GetAutoManagementConfiguration.ts";

export const GetAutoManagementConfigurationHttp = Layer.effect(
  GetAutoManagementConfiguration,
  makeServiceQuotasHttpBinding({
    capability: "GetAutoManagementConfiguration",
    iamActions: ["servicequotas:GetAutoManagementConfiguration"],
    operation: servicequotas.getAutoManagementConfiguration,
  }),
);
