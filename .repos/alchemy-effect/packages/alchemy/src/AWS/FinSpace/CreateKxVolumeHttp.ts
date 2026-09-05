import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { CreateKxVolume } from "./CreateKxVolume.ts";

export const CreateKxVolumeHttp = Layer.effect(
  CreateKxVolume,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.CreateKxVolume",
    operation: finspace.createKxVolume,
    actions: ["finspace:CreateKxVolume"],
  }),
);
