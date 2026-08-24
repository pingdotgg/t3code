import * as route53 from "@distilled.cloud/aws/route-53";
import * as Layer from "effect/Layer";
import { makeRoute53AccountHttpBinding } from "./BindingHttp.ts";
import { ListHostedZones } from "./ListHostedZones.ts";

export const ListHostedZonesHttp = Layer.effect(
  ListHostedZones,
  makeRoute53AccountHttpBinding({
    tag: "AWS.Route53.ListHostedZones",
    operation: route53.listHostedZones,
    actions: ["route53:ListHostedZones"],
  }),
);
