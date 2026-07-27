import * as route53domains from "@distilled.cloud/aws/route-53-domains";
import * as Layer from "effect/Layer";
import { makeRoute53DomainsHttpBinding } from "./BindingHttp.ts";
import { CheckDomainTransferability } from "./CheckDomainTransferability.ts";

export const CheckDomainTransferabilityHttp = Layer.effect(
  CheckDomainTransferability,
  makeRoute53DomainsHttpBinding({
    capability: "CheckDomainTransferability",
    iamActions: ["route53domains:CheckDomainTransferability"],
    operation: route53domains.checkDomainTransferability,
  }),
);
