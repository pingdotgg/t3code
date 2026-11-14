import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { GetBucketStatistics } from "./GetBucketStatistics.ts";

export const GetBucketStatisticsHttp = Layer.effect(
  GetBucketStatistics,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.GetBucketStatistics",
    operation: macie2.getBucketStatistics,
    actions: ["macie2:GetBucketStatistics"],
  }),
);
