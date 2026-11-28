import * as databrew from "@distilled.cloud/aws/databrew";
import * as Layer from "effect/Layer";
import { makeDataBrewJobHttpBinding } from "./BindingHttp.ts";
import { StopJobRun } from "./StopJobRun.ts";

export const StopJobRunHttp = Layer.effect(
  StopJobRun,
  makeDataBrewJobHttpBinding({
    tag: "AWS.DataBrew.StopJobRun",
    operation: databrew.stopJobRun,
    actions: ["databrew:StopJobRun"],
  }),
);
