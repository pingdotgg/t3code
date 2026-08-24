import * as servicequotas from "@distilled.cloud/aws/service-quotas";
import * as Layer from "effect/Layer";
import { makeServiceQuotasHttpBinding } from "./BindingHttp.ts";
import { GetAWSDefaultServiceQuota } from "./GetAWSDefaultServiceQuota.ts";

export const GetAWSDefaultServiceQuotaHttp = Layer.effect(
  GetAWSDefaultServiceQuota,
  makeServiceQuotasHttpBinding({
    capability: "GetAWSDefaultServiceQuota",
    iamActions: ["servicequotas:GetAWSDefaultServiceQuota"],
    operation: servicequotas.getAWSDefaultServiceQuota,
  }),
);
