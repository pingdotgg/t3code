import * as amplify from "@distilled.cloud/aws/amplify";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { makeAmplifyHttpBinding } from "./BindingHttp.ts";
import { DeleteJob } from "./DeleteJob.ts";

export const DeleteJobHttp = Layer.effect(
  DeleteJob,
  makeAmplifyHttpBinding({
    name: "DeleteJob",
    operation: amplify.deleteJob,
    actions: ["amplify:DeleteJob"],
    resources: (app) => [Output.interpolate`${app.appArn}/branches/*/jobs/*`],
  }),
);
