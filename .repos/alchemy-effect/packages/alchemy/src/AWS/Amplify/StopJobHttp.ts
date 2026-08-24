import * as amplify from "@distilled.cloud/aws/amplify";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { makeAmplifyHttpBinding } from "./BindingHttp.ts";
import { StopJob } from "./StopJob.ts";

export const StopJobHttp = Layer.effect(
  StopJob,
  makeAmplifyHttpBinding({
    name: "StopJob",
    operation: amplify.stopJob,
    actions: ["amplify:StopJob"],
    resources: (app) => [Output.interpolate`${app.appArn}/branches/*/jobs/*`],
  }),
);
