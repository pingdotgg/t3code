import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { StartMetadataGenerationRun } from "./StartMetadataGenerationRun.ts";

export const StartMetadataGenerationRunHttp = Layer.effect(
  StartMetadataGenerationRun,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.StartMetadataGenerationRun",
    operation: datazone.startMetadataGenerationRun,
    actions: ["datazone:StartMetadataGenerationRun"],
  }),
);
