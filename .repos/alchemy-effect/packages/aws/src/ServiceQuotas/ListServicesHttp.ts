import * as servicequotas from "@distilled.cloud/aws/service-quotas";
import * as Layer from "effect/Layer";
import { makeServiceQuotasHttpBinding } from "./BindingHttp.ts";
import { ListServices } from "./ListServices.ts";

export const ListServicesHttp = Layer.effect(
  ListServices,
  makeServiceQuotasHttpBinding({
    capability: "ListServices",
    iamActions: ["servicequotas:ListServices"],
    operation: servicequotas.listServices,
  }),
);
