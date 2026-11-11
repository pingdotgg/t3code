import * as codeartifact from "@distilled.cloud/aws/codeartifact";
import * as Layer from "effect/Layer";
import { makeRepositoryHttpBinding, packageArns } from "./BindingHttp.ts";
import { PublishPackageVersion } from "./PublishPackageVersion.ts";

/** HTTP implementation of {@link PublishPackageVersion} over the CodeArtifact API. */
export const PublishPackageVersionHttp = Layer.effect(
  PublishPackageVersion,
  makeRepositoryHttpBinding({
    tag: "AWS.CodeArtifact.PublishPackageVersion",
    operation: codeartifact.publishPackageVersion,
    actions: ["codeartifact:PublishPackageVersion"],
    resources: packageArns,
  }),
);
