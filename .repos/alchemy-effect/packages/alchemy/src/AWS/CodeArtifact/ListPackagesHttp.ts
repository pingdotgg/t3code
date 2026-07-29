import * as codeartifact from "@distilled.cloud/aws/codeartifact";
import * as Layer from "effect/Layer";
import { makeRepositoryHttpBinding } from "./BindingHttp.ts";
import { ListPackages } from "./ListPackages.ts";

/** HTTP implementation of {@link ListPackages} over the CodeArtifact API. */
export const ListPackagesHttp = Layer.effect(
  ListPackages,
  makeRepositoryHttpBinding({
    tag: "AWS.CodeArtifact.ListPackages",
    operation: codeartifact.listPackages,
    actions: ["codeartifact:ListPackages"],
  }),
);
