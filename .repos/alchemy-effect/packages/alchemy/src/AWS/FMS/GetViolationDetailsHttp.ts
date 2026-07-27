import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { GetViolationDetails } from "./GetViolationDetails.ts";

export const GetViolationDetailsHttp = Layer.effect(
  GetViolationDetails,
  makeFmsHttpBinding({
    capability: "GetViolationDetails",
    iamActions: ["fms:GetViolationDetails"],
    operation: fms.getViolationDetails,
  }),
);
