import * as route53 from "@distilled.cloud/aws/route-53";
import * as Layer from "effect/Layer";
import { makeRoute53ZoneHttpBinding } from "./BindingHttp.ts";
import { GetHostedZone } from "./GetHostedZone.ts";

export const GetHostedZoneHttp = Layer.effect(
  GetHostedZone,
  makeRoute53ZoneHttpBinding({
    tag: "AWS.Route53.GetHostedZone",
    operation: route53.getHostedZone,
    actions: ["route53:GetHostedZone"],
    // getHostedZone addresses the zone as `Id`, not `HostedZoneId`.
    requestKey: "Id",
  }),
);
