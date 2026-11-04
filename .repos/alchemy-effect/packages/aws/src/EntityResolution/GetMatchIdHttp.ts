import * as entityresolution from "@distilled.cloud/aws/entityresolution";
import * as Layer from "effect/Layer";
import { makeWorkflowHttpBinding } from "./BindingHttp.ts";
import { GetMatchId } from "./GetMatchId.ts";

export const GetMatchIdHttp = Layer.effect(
  GetMatchId,
  makeWorkflowHttpBinding({
    tag: "AWS.EntityResolution.GetMatchId",
    operation: entityresolution.getMatchId,
    actions: ["entityresolution:GetMatchId"],
  }),
);
