import * as amplify from "@distilled.cloud/aws/amplify";
import * as Output from "alchemy/Output";
import * as Layer from "effect/Layer";
import { makeAmplifyHttpBinding } from "./BindingHttp.ts";
import { CreateDeployment } from "./CreateDeployment.ts";

export const CreateDeploymentHttp = Layer.effect(
  CreateDeployment,
  makeAmplifyHttpBinding({
    name: "CreateDeployment",
    operation: amplify.createDeployment,
    actions: ["amplify:CreateDeployment"],
    resources: (app) => [Output.interpolate`${app.appArn}/branches/*`],
  }),
);
