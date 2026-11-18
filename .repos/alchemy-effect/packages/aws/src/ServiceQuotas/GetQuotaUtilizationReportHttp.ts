import * as servicequotas from "@distilled.cloud/aws/service-quotas";
import * as Layer from "effect/Layer";
import { makeServiceQuotasHttpBinding } from "./BindingHttp.ts";
import { GetQuotaUtilizationReport } from "./GetQuotaUtilizationReport.ts";

export const GetQuotaUtilizationReportHttp = Layer.effect(
  GetQuotaUtilizationReport,
  makeServiceQuotasHttpBinding({
    capability: "GetQuotaUtilizationReport",
    iamActions: ["servicequotas:GetQuotaUtilizationReport"],
    operation: servicequotas.getQuotaUtilizationReport,
  }),
);
