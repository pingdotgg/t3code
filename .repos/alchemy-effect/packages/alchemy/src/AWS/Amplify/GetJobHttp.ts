import * as amplify from "@distilled.cloud/aws/amplify";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { makeAmplifyHttpBinding } from "./BindingHttp.ts";
import { GetJob } from "./GetJob.ts";

export const GetJobHttp = Layer.effect(
  GetJob,
  makeAmplifyHttpBinding({
    name: "GetJob",
    operation: amplify.getJob,
    actions: ["amplify:GetJob"],
    resources: (app) => [Output.interpolate`${app.appArn}/branches/*/jobs/*`],
  }),
);
