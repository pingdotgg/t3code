import * as entityresolution from "@distilled.cloud/aws/entityresolution";
import * as Layer from "effect/Layer";
import { makeWorkflowHttpBinding } from "./BindingHttp.ts";
import { GenerateMatchId } from "./GenerateMatchId.ts";

export const GenerateMatchIdHttp = Layer.effect(
  GenerateMatchId,
  makeWorkflowHttpBinding({
    tag: "AWS.EntityResolution.GenerateMatchId",
    operation: entityresolution.generateMatchId,
    actions: ["entityresolution:GenerateMatchId"],
  }),
);
