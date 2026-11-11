import * as amplify from "@distilled.cloud/aws/amplify";
import * as Output from "alchemy/Output";
import * as Layer from "effect/Layer";
import { makeAmplifyHttpBinding } from "./BindingHttp.ts";
import { ListJobs } from "./ListJobs.ts";

export const ListJobsHttp = Layer.effect(
  ListJobs,
  makeAmplifyHttpBinding({
    name: "ListJobs",
    operation: amplify.listJobs,
    actions: ["amplify:ListJobs"],
    resources: (app) => [Output.interpolate`${app.appArn}/branches/*/jobs/*`],
  }),
);
