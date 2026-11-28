import * as forecast from "@distilled.cloud/aws/forecast";
import * as Layer from "effect/Layer";
import { makeForecastHttpBinding } from "./BindingHttp.ts";
import { ResumeResource } from "./ResumeResource.ts";

export const ResumeResourceHttp = Layer.effect(
  ResumeResource,
  makeForecastHttpBinding({
    capability: "ResumeResource",
    iamActions: ["forecast:ResumeResource"],
    operation: forecast.resumeResource,
  }),
);
