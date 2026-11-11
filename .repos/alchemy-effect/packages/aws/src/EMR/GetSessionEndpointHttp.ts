import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { GetSessionEndpoint } from "./GetSessionEndpoint.ts";

export const GetSessionEndpointHttp = Layer.effect(
  GetSessionEndpoint,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.GetSessionEndpoint",
    operation: emr.getSessionEndpoint,
    actions: ["elasticmapreduce:GetSessionEndpoint"],
  }),
);
