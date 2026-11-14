import * as codeartifact from "@distilled.cloud/aws/codeartifact";
import * as Layer from "effect/Layer";
import { makeRepositoryHttpBinding, packageArns } from "./BindingHttp.ts";
import { UpdatePackageVersionsStatus } from "./UpdatePackageVersionsStatus.ts";

/** HTTP implementation of {@link UpdatePackageVersionsStatus} over the CodeArtifact API. */
export const UpdatePackageVersionsStatusHttp = Layer.effect(
  UpdatePackageVersionsStatus,
  makeRepositoryHttpBinding({
    tag: "AWS.CodeArtifact.UpdatePackageVersionsStatus",
    operation: codeartifact.updatePackageVersionsStatus,
    actions: ["codeartifact:UpdatePackageVersionsStatus"],
    resources: packageArns,
  }),
);
