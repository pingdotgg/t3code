import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { GetOnClusterAppUIPresignedURL } from "./GetOnClusterAppUIPresignedURL.ts";

export const GetOnClusterAppUIPresignedURLHttp = Layer.effect(
  GetOnClusterAppUIPresignedURL,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.GetOnClusterAppUIPresignedURL",
    operation: emr.getOnClusterAppUIPresignedURL,
    actions: ["elasticmapreduce:GetOnClusterAppUIPresignedURL"],
  }),
);
