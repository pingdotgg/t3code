import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { GetTimeSeriesDataPoint } from "./GetTimeSeriesDataPoint.ts";

export const GetTimeSeriesDataPointHttp = Layer.effect(
  GetTimeSeriesDataPoint,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.GetTimeSeriesDataPoint",
    operation: datazone.getTimeSeriesDataPoint,
    actions: ["datazone:GetTimeSeriesDataPoint"],
  }),
);
