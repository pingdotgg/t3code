import * as lf from "@distilled.cloud/aws/lakeformation";
import * as Layer from "effect/Layer";
import { makeLakeFormationHttpBinding } from "./BindingHttp.ts";
import { GetTemporaryGluePartitionCredentials } from "./GetTemporaryGluePartitionCredentials.ts";

export const GetTemporaryGluePartitionCredentialsHttp = Layer.effect(
  GetTemporaryGluePartitionCredentials,
  makeLakeFormationHttpBinding({
    capability: "GetTemporaryGluePartitionCredentials",
    iamActions: ["lakeformation:GetDataAccess"],
    operation: lf.getTemporaryGluePartitionCredentials,
  }),
);
