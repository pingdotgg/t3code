import * as codeartifact from "@distilled.cloud/aws/codeartifact";
import * as Layer from "effect/Layer";
import { makeRepositoryHttpBinding, packageArns } from "./BindingHttp.ts";
import { DisposePackageVersions } from "./DisposePackageVersions.ts";

/** HTTP implementation of {@link DisposePackageVersions} over the CodeArtifact API. */
export const DisposePackageVersionsHttp = Layer.effect(
  DisposePackageVersions,
  makeRepositoryHttpBinding({
    tag: "AWS.CodeArtifact.DisposePackageVersions",
    operation: codeartifact.disposePackageVersions,
    actions: ["codeartifact:DisposePackageVersions"],
    resources: packageArns,
  }),
);
