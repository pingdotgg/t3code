import * as athena from "@distilled.cloud/aws/athena";
import * as Layer from "effect/Layer";
import { makeWorkGroupScopedHttpBinding } from "./BindingHttp.ts";
import { GetQueryRuntimeStatistics } from "./GetQueryRuntimeStatistics.ts";

export const GetQueryRuntimeStatisticsHttp = Layer.effect(
  GetQueryRuntimeStatistics,
  makeWorkGroupScopedHttpBinding({
    tag: "AWS.Athena.GetQueryRuntimeStatistics",
    operation: athena.getQueryRuntimeStatistics,
    actions: ["athena:GetQueryRuntimeStatistics"],
  }),
);
