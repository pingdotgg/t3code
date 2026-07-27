import * as amplify from "@distilled.cloud/aws/amplify";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { makeAmplifyHttpBinding } from "./BindingHttp.ts";
import { StartDeployment } from "./StartDeployment.ts";

export const StartDeploymentHttp = Layer.effect(
  StartDeployment,
  makeAmplifyHttpBinding({
    name: "StartDeployment",
    operation: amplify.startDeployment,
    actions: ["amplify:StartDeployment"],
    resources: (app) => [Output.interpolate`${app.appArn}/branches/*`],
  }),
);
