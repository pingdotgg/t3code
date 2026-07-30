import * as codeartifact from "@distilled.cloud/aws/codeartifact";
import * as Layer from "effect/Layer";
import { makeRepositoryHttpBinding, packageArns } from "./BindingHttp.ts";
import { DescribePackageVersion } from "./DescribePackageVersion.ts";

/** HTTP implementation of {@link DescribePackageVersion} over the CodeArtifact API. */
export const DescribePackageVersionHttp = Layer.effect(
  DescribePackageVersion,
  makeRepositoryHttpBinding({
    tag: "AWS.CodeArtifact.DescribePackageVersion",
    operation: codeartifact.describePackageVersion,
    actions: ["codeartifact:DescribePackageVersion"],
    resources: packageArns,
  }),
);
