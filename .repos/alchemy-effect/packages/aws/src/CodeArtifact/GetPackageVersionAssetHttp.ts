import * as codeartifact from "@distilled.cloud/aws/codeartifact";
import * as Layer from "effect/Layer";
import { makeRepositoryHttpBinding, packageArns } from "./BindingHttp.ts";
import { GetPackageVersionAsset } from "./GetPackageVersionAsset.ts";

/** HTTP implementation of {@link GetPackageVersionAsset} over the CodeArtifact API. */
export const GetPackageVersionAssetHttp = Layer.effect(
  GetPackageVersionAsset,
  makeRepositoryHttpBinding({
    tag: "AWS.CodeArtifact.GetPackageVersionAsset",
    operation: codeartifact.getPackageVersionAsset,
    actions: ["codeartifact:GetPackageVersionAsset"],
    resources: packageArns,
  }),
);
