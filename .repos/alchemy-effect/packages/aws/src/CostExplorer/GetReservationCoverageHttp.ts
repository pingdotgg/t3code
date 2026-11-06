import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetReservationCoverage } from "./GetReservationCoverage.ts";

export const GetReservationCoverageHttp = Layer.effect(
  GetReservationCoverage,
  makeCostExplorerHttpBinding({
    capability: "GetReservationCoverage",
    iamActions: ["ce:GetReservationCoverage"],
    operation: ce.getReservationCoverage,
  }),
);
