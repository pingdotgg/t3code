import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetReservationUtilization } from "./GetReservationUtilization.ts";

export const GetReservationUtilizationHttp = Layer.effect(
  GetReservationUtilization,
  makeCostExplorerHttpBinding({
    capability: "GetReservationUtilization",
    iamActions: ["ce:GetReservationUtilization"],
    operation: ce.getReservationUtilization,
  }),
);
