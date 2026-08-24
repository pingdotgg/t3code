import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Layer from "effect/Layer";
import { makeLoadBalancerHttpBinding } from "./BindingHttp.ts";
import { DescribeCapacityReservation } from "./DescribeCapacityReservation.ts";

export const DescribeCapacityReservationHttp = Layer.effect(
  DescribeCapacityReservation,
  makeLoadBalancerHttpBinding({
    tag: "AWS.ELBv2.DescribeCapacityReservation",
    operation: elbv2.describeCapacityReservation,
    actions: ["elasticloadbalancing:DescribeCapacityReservation"],
    resource: "*",
  }),
);
