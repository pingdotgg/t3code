import * as codeartifact from "@distilled.cloud/aws/codeartifact";
import * as Layer from "effect/Layer";
import { makeRepositoryHttpBinding, packageArns } from "./BindingHttp.ts";
import { PutPackageOriginConfiguration } from "./PutPackageOriginConfiguration.ts";

/** HTTP implementation of {@link PutPackageOriginConfiguration} over the CodeArtifact API. */
export const PutPackageOriginConfigurationHttp = Layer.effect(
  PutPackageOriginConfiguration,
  makeRepositoryHttpBinding({
    tag: "AWS.CodeArtifact.PutPackageOriginConfiguration",
    operation: codeartifact.putPackageOriginConfiguration,
    actions: ["codeartifact:PutPackageOriginConfiguration"],
    resources: packageArns,
  }),
);
