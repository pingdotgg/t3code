import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { DescribeBuckets } from "./DescribeBuckets.ts";

export const DescribeBucketsHttp = Layer.effect(
  DescribeBuckets,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.DescribeBuckets",
    operation: macie2.describeBuckets,
    actions: ["macie2:DescribeBuckets"],
  }),
);
