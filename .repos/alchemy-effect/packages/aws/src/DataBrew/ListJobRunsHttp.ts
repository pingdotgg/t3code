import * as databrew from "@distilled.cloud/aws/databrew";
import * as Layer from "effect/Layer";
import { makeDataBrewJobHttpBinding } from "./BindingHttp.ts";
import { ListJobRuns } from "./ListJobRuns.ts";

export const ListJobRunsHttp = Layer.effect(
  ListJobRuns,
  makeDataBrewJobHttpBinding({
    tag: "AWS.DataBrew.ListJobRuns",
    operation: databrew.listJobRuns,
    actions: ["databrew:ListJobRuns"],
  }),
);
