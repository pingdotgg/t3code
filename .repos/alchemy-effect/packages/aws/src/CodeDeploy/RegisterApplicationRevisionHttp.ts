import * as codedeploy from "@distilled.cloud/aws/codedeploy";
import * as Layer from "effect/Layer";
import { makeCodeDeployApplicationHttpBinding } from "./BindingHttp.ts";
import { RegisterApplicationRevision } from "./RegisterApplicationRevision.ts";

export const RegisterApplicationRevisionHttp = Layer.effect(
  RegisterApplicationRevision,
  makeCodeDeployApplicationHttpBinding({
    tag: "AWS.CodeDeploy.RegisterApplicationRevision",
    operation: codedeploy.registerApplicationRevision,
    actions: ["codedeploy:RegisterApplicationRevision"],
  }),
);
