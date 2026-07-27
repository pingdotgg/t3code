import type * as codeartifact from "@distilled.cloud/aws/codeartifact";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link DescribePackageVersion} — `domain`, `domainOwner`, and
 * `repository` are injected from the bound {@link Repository}.
 */
export interface DescribePackageVersionRequest extends Omit<
  codeartifact.DescribePackageVersionRequest,
  "domain" | "domainOwner" | "repository"
> {}

/**
 * Runtime binding for `codeartifact:DescribePackageVersion`.
 *
 * Reads a single package version's description — status, revision, origin, and license metadata. Provide the implementation with
 * `Effect.provide(AWS.CodeArtifact.DescribePackageVersionHttp)`.
 * @binding
 * @section Inspecting Package Versions
 * @example Describe a Package Version
 * ```typescript
 * const describeVersion = yield* AWS.CodeArtifact.DescribePackageVersion(repo);
 *
 * const res = yield* describeVersion({
 *   format: "generic",
 *   namespace: "my-ns",
 *   package: "my-package",
 *   packageVersion: "1.0.0",
 * });
 * console.log(res.packageVersion?.status);
 * ```
 */
export interface DescribePackageVersion extends Binding.Service<
  DescribePackageVersion,
  "AWS.CodeArtifact.DescribePackageVersion",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: DescribePackageVersionRequest,
    ) => Effect.Effect<
      codeartifact.DescribePackageVersionResult,
      codeartifact.DescribePackageVersionError
    >
  >
> {}

export const DescribePackageVersion = Binding.Service<DescribePackageVersion>(
  "AWS.CodeArtifact.DescribePackageVersion",
);
