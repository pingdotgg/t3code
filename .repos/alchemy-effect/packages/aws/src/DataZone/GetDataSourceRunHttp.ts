import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { GetDataSourceRun } from "./GetDataSourceRun.ts";

export const GetDataSourceRunHttp = Layer.effect(
  GetDataSourceRun,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.GetDataSourceRun",
    operation: datazone.getDataSourceRun,
    actions: ["datazone:GetDataSourceRun"],
  }),
);
