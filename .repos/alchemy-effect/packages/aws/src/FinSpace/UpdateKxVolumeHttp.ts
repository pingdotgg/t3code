import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { UpdateKxVolume } from "./UpdateKxVolume.ts";

export const UpdateKxVolumeHttp = Layer.effect(
  UpdateKxVolume,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.UpdateKxVolume",
    operation: finspace.updateKxVolume,
    actions: ["finspace:UpdateKxVolume"],
  }),
);
