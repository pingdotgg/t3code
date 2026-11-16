import * as databrew from "@distilled.cloud/aws/databrew";
import * as Layer from "effect/Layer";
import { makeDataBrewJobHttpBinding } from "./BindingHttp.ts";
import { DescribeJobRun } from "./DescribeJobRun.ts";

export const DescribeJobRunHttp = Layer.effect(
  DescribeJobRun,
  makeDataBrewJobHttpBinding({
    tag: "AWS.DataBrew.DescribeJobRun",
    operation: databrew.describeJobRun,
    actions: ["databrew:DescribeJobRun"],
  }),
);
