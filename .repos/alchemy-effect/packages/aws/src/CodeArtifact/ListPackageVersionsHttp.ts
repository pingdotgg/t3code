import * as codeartifact from "@distilled.cloud/aws/codeartifact";
import * as Layer from "effect/Layer";
import { makeRepositoryHttpBinding, packageArns } from "./BindingHttp.ts";
import { ListPackageVersions } from "./ListPackageVersions.ts";

/** HTTP implementation of {@link ListPackageVersions} over the CodeArtifact API. */
export const ListPackageVersionsHttp = Layer.effect(
  ListPackageVersions,
  makeRepositoryHttpBinding({
    tag: "AWS.CodeArtifact.ListPackageVersions",
    operation: codeartifact.listPackageVersions,
    actions: ["codeartifact:ListPackageVersions"],
    resources: packageArns,
  }),
);
