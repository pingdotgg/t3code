import * as lf from "@distilled.cloud/aws/lakeformation";
import * as Layer from "effect/Layer";
import { makeLakeFormationHttpBinding } from "./BindingHttp.ts";
import { GetTemporaryDataLocationCredentials } from "./GetTemporaryDataLocationCredentials.ts";

export const GetTemporaryDataLocationCredentialsHttp = Layer.effect(
  GetTemporaryDataLocationCredentials,
  makeLakeFormationHttpBinding({
    capability: "GetTemporaryDataLocationCredentials",
    iamActions: ["lakeformation:GetDataAccess"],
    operation: lf.getTemporaryDataLocationCredentials,
  }),
);
