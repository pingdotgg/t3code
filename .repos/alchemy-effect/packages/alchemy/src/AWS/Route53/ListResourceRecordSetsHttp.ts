import * as route53 from "@distilled.cloud/aws/route-53";
import * as Layer from "effect/Layer";
import { makeRoute53ZoneHttpBinding } from "./BindingHttp.ts";
import { ListResourceRecordSets } from "./ListResourceRecordSets.ts";

export const ListResourceRecordSetsHttp = Layer.effect(
  ListResourceRecordSets,
  makeRoute53ZoneHttpBinding({
    tag: "AWS.Route53.ListResourceRecordSets",
    operation: route53.listResourceRecordSets,
    actions: ["route53:ListResourceRecordSets"],
  }),
);
