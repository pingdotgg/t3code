import * as servicequotas from "@distilled.cloud/aws/service-quotas";
import * as Layer from "effect/Layer";
import { makeServiceQuotasHttpBinding } from "./BindingHttp.ts";
import { GetRequestedServiceQuotaChange } from "./GetRequestedServiceQuotaChange.ts";

export const GetRequestedServiceQuotaChangeHttp = Layer.effect(
  GetRequestedServiceQuotaChange,
  makeServiceQuotasHttpBinding({
    capability: "GetRequestedServiceQuotaChange",
    iamActions: ["servicequotas:GetRequestedServiceQuotaChange"],
    operation: servicequotas.getRequestedServiceQuotaChange,
  }),
);
