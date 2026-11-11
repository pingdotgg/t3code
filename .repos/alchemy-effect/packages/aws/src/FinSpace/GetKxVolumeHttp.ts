import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { GetKxVolume } from "./GetKxVolume.ts";

export const GetKxVolumeHttp = Layer.effect(
  GetKxVolume,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.GetKxVolume",
    operation: finspace.getKxVolume,
    actions: ["finspace:GetKxVolume"],
  }),
);
