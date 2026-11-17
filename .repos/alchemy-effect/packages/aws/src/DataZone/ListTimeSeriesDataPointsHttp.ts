import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { ListTimeSeriesDataPoints } from "./ListTimeSeriesDataPoints.ts";

export const ListTimeSeriesDataPointsHttp = Layer.effect(
  ListTimeSeriesDataPoints,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.ListTimeSeriesDataPoints",
    operation: datazone.listTimeSeriesDataPoints,
    actions: ["datazone:ListTimeSeriesDataPoints"],
  }),
);
