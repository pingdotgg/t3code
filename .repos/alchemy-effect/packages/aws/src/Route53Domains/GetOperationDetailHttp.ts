import * as route53domains from "@distilled.cloud/aws/route-53-domains";
import * as Layer from "effect/Layer";
import { makeRoute53DomainsHttpBinding } from "./BindingHttp.ts";
import { GetOperationDetail } from "./GetOperationDetail.ts";

export const GetOperationDetailHttp = Layer.effect(
  GetOperationDetail,
  makeRoute53DomainsHttpBinding({
    capability: "GetOperationDetail",
    iamActions: ["route53domains:GetOperationDetail"],
    operation: route53domains.getOperationDetail,
  }),
);
