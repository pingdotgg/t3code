import * as servicequotas from "@distilled.cloud/aws/service-quotas";
import * as Layer from "effect/Layer";
import { makeServiceQuotasHttpBinding } from "./BindingHttp.ts";
import { ListAWSDefaultServiceQuotas } from "./ListAWSDefaultServiceQuotas.ts";

export const ListAWSDefaultServiceQuotasHttp = Layer.effect(
  ListAWSDefaultServiceQuotas,
  makeServiceQuotasHttpBinding({
    capability: "ListAWSDefaultServiceQuotas",
    iamActions: ["servicequotas:ListAWSDefaultServiceQuotas"],
    operation: servicequotas.listAWSDefaultServiceQuotas,
  }),
);
