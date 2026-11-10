import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { GetComplianceDetail } from "./GetComplianceDetail.ts";

export const GetComplianceDetailHttp = Layer.effect(
  GetComplianceDetail,
  makeFmsHttpBinding({
    capability: "GetComplianceDetail",
    iamActions: ["fms:GetComplianceDetail"],
    operation: fms.getComplianceDetail,
  }),
);
