import * as databrew from "@distilled.cloud/aws/databrew";
import * as Layer from "effect/Layer";
import { makeDataBrewJobHttpBinding } from "./BindingHttp.ts";
import { StartJobRun } from "./StartJobRun.ts";

export const StartJobRunHttp = Layer.effect(
  StartJobRun,
  makeDataBrewJobHttpBinding({
    tag: "AWS.DataBrew.StartJobRun",
    operation: databrew.startJobRun,
    actions: ["databrew:StartJobRun"],
  }),
);
