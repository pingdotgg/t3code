import * as route53domains from "@distilled.cloud/aws/route-53-domains";
import * as Layer from "effect/Layer";
import { makeRoute53DomainsHttpBinding } from "./BindingHttp.ts";
import { ListDomains } from "./ListDomains.ts";

export const ListDomainsHttp = Layer.effect(
  ListDomains,
  makeRoute53DomainsHttpBinding({
    capability: "ListDomains",
    iamActions: ["route53domains:ListDomains"],
    operation: route53domains.listDomains,
  }),
);
