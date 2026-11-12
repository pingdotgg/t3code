import * as route53domains from "@distilled.cloud/aws/route-53-domains";
import * as Layer from "effect/Layer";
import { makeRoute53DomainsHttpBinding } from "./BindingHttp.ts";
import { RetrieveDomainAuthCode } from "./RetrieveDomainAuthCode.ts";

export const RetrieveDomainAuthCodeHttp = Layer.effect(
  RetrieveDomainAuthCode,
  makeRoute53DomainsHttpBinding({
    capability: "RetrieveDomainAuthCode",
    iamActions: ["route53domains:RetrieveDomainAuthCode"],
    operation: route53domains.retrieveDomainAuthCode,
  }),
);
