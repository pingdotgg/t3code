import * as route53 from "@distilled.cloud/aws/route-53";
import * as Layer from "effect/Layer";
import { makeRoute53AccountHttpBinding } from "./BindingHttp.ts";
import { GetChange } from "./GetChange.ts";

export const GetChangeHttp = Layer.effect(
  GetChange,
  makeRoute53AccountHttpBinding({
    tag: "AWS.Route53.GetChange",
    operation: route53.getChange,
    actions: ["route53:GetChange"],
    // Change ids are minted at runtime by ChangeResourceRecordSets and
    // unknowable at deploy time.
    resources: ["arn:aws:route53:::change/*"],
  }),
);
