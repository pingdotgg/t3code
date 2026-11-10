import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { ListDataSourceRuns } from "./ListDataSourceRuns.ts";

export const ListDataSourceRunsHttp = Layer.effect(
  ListDataSourceRuns,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.ListDataSourceRuns",
    operation: datazone.listDataSourceRuns,
    actions: ["datazone:ListDataSourceRuns"],
  }),
);
