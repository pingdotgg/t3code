import * as codedeploy from "@distilled.cloud/aws/codedeploy";
import * as Layer from "effect/Layer";
import { makeCodeDeployApplicationHttpBinding } from "./BindingHttp.ts";
import { GetApplicationRevision } from "./GetApplicationRevision.ts";

export const GetApplicationRevisionHttp = Layer.effect(
  GetApplicationRevision,
  makeCodeDeployApplicationHttpBinding({
    tag: "AWS.CodeDeploy.GetApplicationRevision",
    operation: codedeploy.getApplicationRevision,
    actions: ["codedeploy:GetApplicationRevision"],
  }),
);
