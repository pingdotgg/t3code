import * as amplify from "@distilled.cloud/aws/amplify";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { makeAmplifyHttpBinding } from "./BindingHttp.ts";
import { StartJob } from "./StartJob.ts";

export const StartJobHttp = Layer.effect(
  StartJob,
  makeAmplifyHttpBinding({
    name: "StartJob",
    operation: amplify.startJob,
    actions: ["amplify:StartJob"],
    resources: (app) => [Output.interpolate`${app.appArn}/branches/*/jobs/*`],
  }),
);
