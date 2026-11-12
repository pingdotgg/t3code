import * as codeartifact from "@distilled.cloud/aws/codeartifact";
import * as Layer from "effect/Layer";
import { makeRepositoryHttpBinding, packageArns } from "./BindingHttp.ts";
import { ListPackageVersionAssets } from "./ListPackageVersionAssets.ts";

/** HTTP implementation of {@link ListPackageVersionAssets} over the CodeArtifact API. */
export const ListPackageVersionAssetsHttp = Layer.effect(
  ListPackageVersionAssets,
  makeRepositoryHttpBinding({
    tag: "AWS.CodeArtifact.ListPackageVersionAssets",
    operation: codeartifact.listPackageVersionAssets,
    actions: ["codeartifact:ListPackageVersionAssets"],
    resources: packageArns,
  }),
);
