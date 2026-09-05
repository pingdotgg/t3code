import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { GetPersistentAppUIPresignedURL } from "./GetPersistentAppUIPresignedURL.ts";

export const GetPersistentAppUIPresignedURLHttp = Layer.effect(
  GetPersistentAppUIPresignedURL,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.GetPersistentAppUIPresignedURL",
    operation: emr.getPersistentAppUIPresignedURL,
    actions: ["elasticmapreduce:GetPersistentAppUIPresignedURL"],
    inject: "none",
  }),
);
