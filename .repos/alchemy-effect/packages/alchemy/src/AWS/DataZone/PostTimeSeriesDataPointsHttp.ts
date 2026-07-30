import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { PostTimeSeriesDataPoints } from "./PostTimeSeriesDataPoints.ts";

export const PostTimeSeriesDataPointsHttp = Layer.effect(
  PostTimeSeriesDataPoints,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.PostTimeSeriesDataPoints",
    operation: datazone.postTimeSeriesDataPoints,
    actions: ["datazone:PostTimeSeriesDataPoints"],
  }),
);
