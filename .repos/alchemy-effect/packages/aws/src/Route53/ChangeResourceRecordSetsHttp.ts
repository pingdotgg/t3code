import * as route53 from "@distilled.cloud/aws/route-53";
import * as Layer from "effect/Layer";
import { makeRoute53ZoneHttpBinding } from "./BindingHttp.ts";
import { ChangeResourceRecordSets } from "./ChangeResourceRecordSets.ts";

export const ChangeResourceRecordSetsHttp = Layer.effect(
  ChangeResourceRecordSets,
  makeRoute53ZoneHttpBinding({
    tag: "AWS.Route53.ChangeResourceRecordSets",
    operation: route53.changeResourceRecordSets,
    actions: ["route53:ChangeResourceRecordSets"],
  }),
);
