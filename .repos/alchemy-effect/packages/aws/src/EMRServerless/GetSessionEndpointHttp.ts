import * as emr from "@distilled.cloud/aws/emr-serverless";
import * as Layer from "effect/Layer";
import { makeEmrServerlessHttpBinding } from "./BindingHttp.ts";
import { GetSessionEndpoint } from "./GetSessionEndpoint.ts";

export const GetSessionEndpointHttp = Layer.effect(
  GetSessionEndpoint,
  makeEmrServerlessHttpBinding({
    tag: "AWS.EMRServerless.GetSessionEndpoint",
    operation: emr.getSessionEndpoint,
    actions: ["emr-serverless:GetSessionEndpoint"],
    subresources: ["/sessions/*"],
  }),
);
