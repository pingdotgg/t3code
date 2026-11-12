import * as codeartifact from "@distilled.cloud/aws/codeartifact";
import * as Layer from "effect/Layer";
import { makeRepositoryHttpBinding, packageArns } from "./BindingHttp.ts";
import { ListPackageVersionDependencies } from "./ListPackageVersionDependencies.ts";

/** HTTP implementation of {@link ListPackageVersionDependencies} over the CodeArtifact API. */
export const ListPackageVersionDependenciesHttp = Layer.effect(
  ListPackageVersionDependencies,
  makeRepositoryHttpBinding({
    tag: "AWS.CodeArtifact.ListPackageVersionDependencies",
    operation: codeartifact.listPackageVersionDependencies,
    actions: ["codeartifact:ListPackageVersionDependencies"],
    resources: packageArns,
  }),
);
