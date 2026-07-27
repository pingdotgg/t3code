import type * as codeartifact from "@distilled.cloud/aws/codeartifact";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link DescribePackage} — `domain`, `domainOwner`, and
 * `repository` are injected from the bound {@link Repository}.
 */
export interface DescribePackageRequest extends Omit<
  codeartifact.DescribePackageRequest,
  "domain" | "domainOwner" | "repository"
> {}

/**
 * Runtime binding for `codeartifact:DescribePackage`.
 *
 * Reads a package's description, including its origin configuration, from the bound repository. Provide the implementation with
 * `Effect.provide(AWS.CodeArtifact.DescribePackageHttp)`.
 * @binding
 * @section Inspecting Packages
 * @example Describe a Package
 * ```typescript
 * const describePackage = yield* AWS.CodeArtifact.DescribePackage(repo);
 *
 * const res = yield* describePackage({
 *   format: "generic",
 *   namespace: "my-ns",
 *   package: "my-package",
 * });
 * console.log(res.package?.originConfiguration);
 * ```
 */
export interface DescribePackage extends Binding.Service<
  DescribePackage,
  "AWS.CodeArtifact.DescribePackage",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: DescribePackageRequest,
    ) => Effect.Effect<
      codeartifact.DescribePackageResult,
      codeartifact.DescribePackageError
    >
  >
> {}

export const DescribePackage = Binding.Service<DescribePackage>(
  "AWS.CodeArtifact.DescribePackage",
);
