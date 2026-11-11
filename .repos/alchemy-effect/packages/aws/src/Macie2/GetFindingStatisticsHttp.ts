import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { GetFindingStatistics } from "./GetFindingStatistics.ts";

export const GetFindingStatisticsHttp = Layer.effect(
  GetFindingStatistics,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.GetFindingStatistics",
    operation: macie2.getFindingStatistics,
    actions: ["macie2:GetFindingStatistics"],
  }),
);
