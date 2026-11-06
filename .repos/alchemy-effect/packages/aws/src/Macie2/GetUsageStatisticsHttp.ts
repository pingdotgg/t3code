import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { GetUsageStatistics } from "./GetUsageStatistics.ts";

export const GetUsageStatisticsHttp = Layer.effect(
  GetUsageStatistics,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.GetUsageStatistics",
    operation: macie2.getUsageStatistics,
    actions: ["macie2:GetUsageStatistics"],
  }),
);
