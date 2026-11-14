import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { GetMetadataGenerationRun } from "./GetMetadataGenerationRun.ts";

export const GetMetadataGenerationRunHttp = Layer.effect(
  GetMetadataGenerationRun,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.GetMetadataGenerationRun",
    operation: datazone.getMetadataGenerationRun,
    actions: ["datazone:GetMetadataGenerationRun"],
  }),
);
