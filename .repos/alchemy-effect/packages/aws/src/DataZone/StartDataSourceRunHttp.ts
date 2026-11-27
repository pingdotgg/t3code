import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { StartDataSourceRun } from "./StartDataSourceRun.ts";

export const StartDataSourceRunHttp = Layer.effect(
  StartDataSourceRun,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.StartDataSourceRun",
    operation: datazone.startDataSourceRun,
    actions: ["datazone:StartDataSourceRun"],
  }),
);
