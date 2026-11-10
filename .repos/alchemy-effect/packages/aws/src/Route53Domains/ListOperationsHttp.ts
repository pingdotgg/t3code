import * as route53domains from "@distilled.cloud/aws/route-53-domains";
import * as Layer from "effect/Layer";
import { makeRoute53DomainsHttpBinding } from "./BindingHttp.ts";
import { ListOperations } from "./ListOperations.ts";

export const ListOperationsHttp = Layer.effect(
  ListOperations,
  makeRoute53DomainsHttpBinding({
    capability: "ListOperations",
    iamActions: ["route53domains:ListOperations"],
    operation: route53domains.listOperations,
  }),
);
