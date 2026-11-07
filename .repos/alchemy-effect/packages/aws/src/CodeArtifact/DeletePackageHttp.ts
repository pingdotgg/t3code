import * as codeartifact from "@distilled.cloud/aws/codeartifact";
import * as Layer from "effect/Layer";
import { makeRepositoryHttpBinding, packageArns } from "./BindingHttp.ts";
import { DeletePackage } from "./DeletePackage.ts";

/** HTTP implementation of {@link DeletePackage} over the CodeArtifact API. */
export const DeletePackageHttp = Layer.effect(
  DeletePackage,
  makeRepositoryHttpBinding({
    tag: "AWS.CodeArtifact.DeletePackage",
    operation: codeartifact.deletePackage,
    actions: ["codeartifact:DeletePackage"],
    resources: packageArns,
  }),
);
