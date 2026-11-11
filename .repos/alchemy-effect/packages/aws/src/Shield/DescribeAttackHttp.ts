import * as shield from "@distilled.cloud/aws/shield";
import * as Layer from "effect/Layer";
import { makeShieldHttpBinding } from "./BindingHttp.ts";
import { DescribeAttack } from "./DescribeAttack.ts";

export const DescribeAttackHttp = Layer.effect(
  DescribeAttack,
  makeShieldHttpBinding({
    tag: "AWS.Shield.DescribeAttack",
    operation: shield.describeAttack,
    actions: ["shield:DescribeAttack"],
  }),
);
