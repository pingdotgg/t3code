import * as shield from "@distilled.cloud/aws/shield";
import * as Layer from "effect/Layer";
import { makeShieldHttpBinding } from "./BindingHttp.ts";
import { DescribeAttackStatistics } from "./DescribeAttackStatistics.ts";

export const DescribeAttackStatisticsHttp = Layer.effect(
  DescribeAttackStatistics,
  makeShieldHttpBinding({
    tag: "AWS.Shield.DescribeAttackStatistics",
    operation: shield.describeAttackStatistics,
    actions: ["shield:DescribeAttackStatistics"],
  }),
);
