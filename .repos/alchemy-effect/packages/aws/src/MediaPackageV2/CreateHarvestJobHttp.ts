import * as mediapackagev2 from "@distilled.cloud/aws/mediapackagev2";
import * as Layer from "effect/Layer";
import { makeMediaPackageV2OriginEndpointHttpBinding } from "./BindingHttp.ts";
import { CreateHarvestJob } from "./CreateHarvestJob.ts";

export const CreateHarvestJobHttp = Layer.effect(
  CreateHarvestJob,
  makeMediaPackageV2OriginEndpointHttpBinding({
    tag: "AWS.MediaPackageV2.CreateHarvestJob",
    operation: mediapackagev2.createHarvestJob,
    actions: ["mediapackagev2:CreateHarvestJob"],
    harvestJobScoped: true,
  }),
);
