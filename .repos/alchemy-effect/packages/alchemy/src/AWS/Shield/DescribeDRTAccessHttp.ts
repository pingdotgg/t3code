import * as shield from "@distilled.cloud/aws/shield";
import * as Layer from "effect/Layer";
import { makeShieldHttpBinding } from "./BindingHttp.ts";
import { DescribeDRTAccess } from "./DescribeDRTAccess.ts";

export const DescribeDRTAccessHttp = Layer.effect(
  DescribeDRTAccess,
  makeShieldHttpBinding({
    tag: "AWS.Shield.DescribeDRTAccess",
    operation: shield.describeDRTAccess,
    actions: ["shield:DescribeDRTAccess"],
  }),
);
