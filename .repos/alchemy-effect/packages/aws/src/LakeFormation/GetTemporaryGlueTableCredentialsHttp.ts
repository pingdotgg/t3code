import * as lf from "@distilled.cloud/aws/lakeformation";
import * as Layer from "effect/Layer";
import { makeLakeFormationHttpBinding } from "./BindingHttp.ts";
import { GetTemporaryGlueTableCredentials } from "./GetTemporaryGlueTableCredentials.ts";

export const GetTemporaryGlueTableCredentialsHttp = Layer.effect(
  GetTemporaryGlueTableCredentials,
  makeLakeFormationHttpBinding({
    capability: "GetTemporaryGlueTableCredentials",
    iamActions: ["lakeformation:GetDataAccess"],
    operation: lf.getTemporaryGlueTableCredentials,
  }),
);
