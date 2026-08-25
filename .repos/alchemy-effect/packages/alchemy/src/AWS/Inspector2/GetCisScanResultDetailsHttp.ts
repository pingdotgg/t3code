import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { GetCisScanResultDetails } from "./GetCisScanResultDetails.ts";

export const GetCisScanResultDetailsHttp = Layer.effect(
  GetCisScanResultDetails,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.GetCisScanResultDetails",
    operation: inspector2.getCisScanResultDetails,
    actions: ["inspector2:GetCisScanResultDetails"],
  }),
);
