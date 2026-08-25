import * as codeartifact from "@distilled.cloud/aws/codeartifact";
import * as Layer from "effect/Layer";
import { makeRepositoryHttpBinding, packageArns } from "./BindingHttp.ts";
import { GetPackageVersionReadme } from "./GetPackageVersionReadme.ts";

/** HTTP implementation of {@link GetPackageVersionReadme} over the CodeArtifact API. */
export const GetPackageVersionReadmeHttp = Layer.effect(
  GetPackageVersionReadme,
  makeRepositoryHttpBinding({
    tag: "AWS.CodeArtifact.GetPackageVersionReadme",
    operation: codeartifact.getPackageVersionReadme,
    actions: ["codeartifact:GetPackageVersionReadme"],
    resources: packageArns,
  }),
);
