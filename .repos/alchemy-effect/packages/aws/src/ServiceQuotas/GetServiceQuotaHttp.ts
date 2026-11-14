import * as servicequotas from "@distilled.cloud/aws/service-quotas";
import * as Layer from "effect/Layer";
import { makeServiceQuotasHttpBinding } from "./BindingHttp.ts";
import { GetServiceQuota } from "./GetServiceQuota.ts";

export const GetServiceQuotaHttp = Layer.effect(
  GetServiceQuota,
  makeServiceQuotasHttpBinding({
    capability: "GetServiceQuota",
    iamActions: ["servicequotas:GetServiceQuota"],
    operation: servicequotas.getServiceQuota,
  }),
);
