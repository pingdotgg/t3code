import * as securitylake from "@distilled.cloud/aws/securitylake";
import * as Layer from "effect/Layer";
import { makeSecurityLakeDataLakeHttpBinding } from "./BindingHttp.ts";
import { GetDataLakeSources } from "./GetDataLakeSources.ts";

export const GetDataLakeSourcesHttp = Layer.effect(
  GetDataLakeSources,
  makeSecurityLakeDataLakeHttpBinding({
    tag: "AWS.SecurityLake.GetDataLakeSources",
    operation: securitylake.getDataLakeSources,
    actions: ["securitylake:GetDataLakeSources"],
  }),
);
