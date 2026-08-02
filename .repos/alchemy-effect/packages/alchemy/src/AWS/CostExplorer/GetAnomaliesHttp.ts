import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeAnomalyMonitorHttpBinding } from "./BindingHttp.ts";
import { GetAnomalies } from "./GetAnomalies.ts";

export const GetAnomaliesHttp = Layer.effect(
  GetAnomalies,
  makeAnomalyMonitorHttpBinding({
    capability: "GetAnomalies",
    iamActions: ["ce:GetAnomalies"],
    operation: ce.getAnomalies,
  }),
);
